import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MACOS_TOKENELO_LABELS,
  MACOS_TOKENELO_PACKAGE_CONTRACT,
  createMacLaunchAgentPolicy,
  type MacLaunchAgentExpectation,
  type MacLaunchAgentPolicy,
  type MacPackagedAppMetadata,
} from './macos-launch-agent-policy.js';
import {
  runMacLaunchAgentLifecycle,
  type MacLaunchAgentLifecycleIO,
  type MacLaunchAgentRole,
  type MacLoadedLaunchAgent,
  type MacLifecycleFileStatus,
  type MacLifecycleFileSystem,
} from './macos-launch-agent-lifecycle.js';

export interface MacRuntimeCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface MacRuntimeCommandOptions {
  timeoutMs: number;
}

export interface MacPackagedRuntimeHost {
  platform: string;
  uid: number;
  home: string;
  accountHome: string;
  environment: Readonly<Record<string, string | undefined>>;
  runtimePath: string;
  fs: MacLifecycleFileSystem;
  execFile(command: string, args: readonly string[], options: MacRuntimeCommandOptions): MacRuntimeCommandResult;
}

export interface ParsedPackagedLifecycleArguments {
  appBundlePath: string;
  helperPath: string;
  operation: 'install' | 'uninstall';
}

const TOKEN_HOME_KEY = 'TOKENELO_HOME';
const MACOS_COMMAND_TIMEOUT_MS = 15_000;
const MACOS_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function physicalPath(
  host: MacPackagedRuntimeHost,
  candidate: string,
  kind: 'file' | 'directory',
  label: string,
  executable = false,
): string {
  if (!path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate || candidate.endsWith('/')) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const status = host.fs.lstat(candidate);
  if (!status || status.kind !== kind) throw new Error(`${label} is missing or has the wrong filesystem type`);
  if (host.fs.realpath(candidate) !== candidate) throw new Error(`${label} must resolve to its physical canonical path`);
  if (executable && (status.mode & 0o111) === 0) throw new Error(`${label} is not executable`);
  return candidate;
}

function requiredPlutilValue(
  host: MacPackagedRuntimeHost,
  key: string,
  infoPlistPath: string,
): string {
  const result = host.execFile(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-o', '-', '--', infoPlistPath],
    { timeoutMs: MACOS_COMMAND_TIMEOUT_MS },
  );
  if (result.timedOut || result.status !== 0) throw new Error(`Could not read ${key} from the packaged app Info.plist`);
  return result.stdout.replace(/\r?\n$/u, '');
}

function readExistingTokenHome(host: MacPackagedRuntimeHost, userHome: string): string | undefined {
  const launchAgents = path.posix.join(userHome, 'Library', 'LaunchAgents');
  const values: Array<string | undefined> = [];
  for (const role of ['daemon', 'tray'] as const) {
    const label = MACOS_TOKENELO_LABELS[role];
    const plistPath = path.posix.join(launchAgents, `${label}.plist`);
    const status = host.fs.lstat(plistPath);
    if (!status) continue;
    if (status.kind !== 'file') throw new Error(`Existing ${role} LaunchAgent path is not a regular file`);
    const result = host.execFile(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', '--', plistPath],
      { timeoutMs: MACOS_COMMAND_TIMEOUT_MS },
    );
    if (result.timedOut || result.status !== 0) {
      throw new Error(`Could not safely inspect the existing ${role} LaunchAgent data-home setting`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error(`Existing ${role} LaunchAgent is not parseable plist data`); }
    if (!isPlainRecord(parsed)) throw new Error(`Existing ${role} LaunchAgent has an unknown plist shape`);
    const environment = parsed.EnvironmentVariables;
    if (environment === undefined) {
      values.push(undefined);
      continue;
    }
    if (!isPlainRecord(environment)) throw new Error(`Existing ${role} LaunchAgent environment is not a dictionary`);
    const value = environment[TOKEN_HOME_KEY];
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`Existing ${role} LaunchAgent data-home value is not a string`);
    }
    values.push(value as string | undefined);
  }
  if (values.length === 0) return undefined;
  if (values.some(value => value !== values[0])) {
    throw new Error('Existing Tokenelo LaunchAgents disagree about TOKENELO_HOME; refusing to change either registration');
  }
  const inherited = host.environment[TOKEN_HOME_KEY];
  // Existing registrations define the effective data location. Preserve that exact setting
  // across upgrades even if this one-shot helper inherited a different shell environment.
  if (values[0] !== undefined) return values[0];
  if (inherited !== undefined && inherited !== '') {
    throw new Error('The inherited TOKENELO_HOME differs from the existing package registration');
  }
  return undefined;
}

function validateHome(host: MacPackagedRuntimeHost): string {
  if (!Number.isInteger(host.uid) || host.uid <= 0) throw new Error('Packaged macOS lifecycle refuses root or an invalid user identity');
  const accountHome = physicalPath(host, host.accountHome, 'directory', 'uid account home');
  const home = physicalPath(host, host.home, 'directory', 'current user home');
  const inheritedHome = host.environment.HOME;
  if (home !== accountHome || inheritedHome === undefined || inheritedHome !== accountHome ||
      host.fs.realpath(inheritedHome) !== accountHome) {
    throw new Error('HOME, runtime home, and the uid account home do not identify the same physical directory');
  }
  const homeStatus = host.fs.lstat(home);
  if (!homeStatus || homeStatus.uid !== host.uid) throw new Error('Uid account home is not owned by the current user');
  return home;
}

function physicalPotentialDirectory(host: MacPackagedRuntimeHost, candidate: string): string {
  if (!path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate || candidate.endsWith('/')) {
    throw new Error('TOKENELO_HOME must be an absolute normalized path');
  }
  let ancestor = candidate;
  const suffix: string[] = [];
  while (true) {
    const status = host.fs.lstat(ancestor);
    if (status) {
      if (suffix.length > 0 && status.kind !== 'directory' && status.kind !== 'symlink') {
        throw new Error('TOKENELO_HOME has a non-directory existing ancestor');
      }
      if (suffix.length === 0 && status.kind !== 'directory' && status.kind !== 'symlink') {
        throw new Error('TOKENELO_HOME must resolve to a directory');
      }
      const resolvedAncestor = host.fs.realpath(ancestor);
      const physicalStatus = host.fs.lstat(resolvedAncestor);
      if (!physicalStatus || physicalStatus.kind !== 'directory') {
        throw new Error('TOKENELO_HOME existing target is not a physical directory');
      }
      return path.posix.normalize(path.posix.join(resolvedAncestor, ...suffix));
    }
    const parent = path.posix.dirname(ancestor);
    if (parent === ancestor) throw new Error('TOKENELO_HOME has no existing physical ancestor');
    suffix.unshift(path.posix.basename(ancestor));
    ancestor = parent;
  }
}

function assertTokenHomeDoesNotOverlap(
  host: MacPackagedRuntimeHost,
  tokeneloHome: string | undefined,
  userHome: string,
  appBundlePath: string,
): void {
  if (tokeneloHome === undefined) return;
  const physical = physicalPotentialDirectory(host, tokeneloHome);
  const overlaps = (parent: string, child: string) => child === parent || child.startsWith(parent + '/');
  if (
    overlaps(physical, userHome) ||
    overlaps(appBundlePath, physical) || overlaps(physical, appBundlePath)
  ) {
    throw new Error('TOKENELO_HOME physical target must not overlap the account home or application bundle');
  }
}

export function parseMacPackagedLifecycleArguments(args: readonly string[]): ParsedPackagedLifecycleArguments {
  let appBundlePath: string | undefined;
  let helperPath: string | undefined;
  let operation: 'install' | 'uninstall' = 'install';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--packaged-app') {
      if (appBundlePath !== undefined || args[index + 1] === undefined) throw new Error('Expected one --packaged-app path');
      appBundlePath = args[++index];
    } else if (argument === '--helper-path') {
      if (helperPath !== undefined || args[index + 1] === undefined) throw new Error('Expected one --helper-path path');
      helperPath = args[++index];
    } else if (argument === '--uninstall') {
      if (operation === 'uninstall') throw new Error('--uninstall was supplied more than once');
      operation = 'uninstall';
    } else {
      throw new Error(`Unknown packaged lifecycle option: ${argument}`);
    }
  }
  if (!appBundlePath || !helperPath) throw new Error('Packaged lifecycle requires --packaged-app and --helper-path');
  return { appBundlePath, helperPath, operation };
}

function validatePackagedRuntime(
  input: ParsedPackagedLifecycleArguments,
  host: MacPackagedRuntimeHost,
): { policy: MacLaunchAgentPolicy; uid: number } {
  if (host.platform !== 'darwin') throw new Error('Packaged macOS LaunchAgent lifecycle is available only on macOS');
  const uid = host.uid;
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('Packaged macOS lifecycle refuses root or an invalid user identity');

  const appBundlePath = physicalPath(host, input.appBundlePath, 'directory', 'Tokenelo.app bundle');
  if (path.posix.basename(appBundlePath) !== MACOS_TOKENELO_PACKAGE_CONTRACT.appBundleName) {
    throw new Error('Packaged lifecycle requires the physical Tokenelo.app bundle');
  }
  if (path.posix.dirname(appBundlePath) === '/') throw new Error('Tokenelo.app cannot be a filesystem-root child');

  const contentsPath = physicalPath(host, path.posix.join(appBundlePath, 'Contents'), 'directory', 'app Contents directory');
  const resourcesPath = physicalPath(host, path.posix.join(contentsPath, 'Resources'), 'directory', 'app Resources directory');
  const appRootPath = physicalPath(host, path.posix.join(resourcesPath, 'app'), 'directory', 'packaged app root');
  const helperPath = physicalPath(host, input.helperPath, 'file', 'invoked package lifecycle helper');
  const expectedHelperPath = path.posix.join(appRootPath, MACOS_TOKENELO_PACKAGE_CONTRACT.helperEntry);
  if (helperPath !== expectedHelperPath) {
    throw new Error('Packaged lifecycle helper must be the physical helper inside this Tokenelo.app bundle');
  }
  const macOSPath = physicalPath(host, path.posix.join(contentsPath, 'MacOS'), 'directory', 'app executable directory');
  const infoPlistPath = physicalPath(host, path.posix.join(contentsPath, 'Info.plist'), 'file', 'app Info.plist');
  const executableName = requiredPlutilValue(host, 'CFBundleExecutable', infoPlistPath);
  const bundleIdentifier = requiredPlutilValue(host, 'CFBundleIdentifier', infoPlistPath);
  if (bundleIdentifier !== MACOS_TOKENELO_PACKAGE_CONTRACT.bundleIdentifier ||
      executableName !== MACOS_TOKENELO_PACKAGE_CONTRACT.bundleExecutable ||
      !/^[A-Za-z0-9._-]+$/u.test(executableName)) {
    throw new Error('Info.plist does not identify the expected Tokenelo executable and bundle');
  }
  const executablePath = physicalPath(
    host,
    path.posix.join(macOSPath, executableName),
    'file',
    'bundled Tokenelo executable',
    true,
  );

  const packagePath = physicalPath(host, path.posix.join(appRootPath, 'package.json'), 'file', 'packaged app package.json');
  let packageData: unknown;
  try { packageData = JSON.parse(host.fs.readFile(packagePath)); }
  catch { throw new Error('Packaged app package.json is missing or invalid'); }
  if (!isPlainRecord(packageData) ||
      packageData.name !== MACOS_TOKENELO_PACKAGE_CONTRACT.packageName ||
      packageData.private !== MACOS_TOKENELO_PACKAGE_CONTRACT.packagePrivate ||
      packageData.type !== MACOS_TOKENELO_PACKAGE_CONTRACT.packageType ||
      packageData.main !== MACOS_TOKENELO_PACKAGE_CONTRACT.packageMain) {
    throw new Error('Packaged app package.json does not match the private Tokenelo package contract');
  }

  const daemonEntryPath = physicalPath(
    host,
    path.posix.join(appRootPath, MACOS_TOKENELO_PACKAGE_CONTRACT.daemonEntry),
    'file',
    'packaged daemon entry',
  );
  const trayEntryPath = physicalPath(
    host,
    path.posix.join(appRootPath, MACOS_TOKENELO_PACKAGE_CONTRACT.trayEntry),
    'file',
    'packaged tray entry',
  );
  const runtimePath = physicalPath(host, host.runtimePath, 'file', 'packaged lifecycle runtime');
  const expectedRuntimePath = path.posix.join(appRootPath, 'dist', 'tray', 'macos-launch-agent-runtime.js');
  if (runtimePath !== expectedRuntimePath) {
    throw new Error('Packaged lifecycle runtime must be the compiled adapter inside this Tokenelo.app bundle');
  }

  const userHome = validateHome(host);
  const tokeneloHome = readExistingTokenHome(host, userHome) ??
    (host.environment[TOKEN_HOME_KEY] === '' ? undefined : host.environment[TOKEN_HOME_KEY]);
  assertTokenHomeDoesNotOverlap(host, tokeneloHome, userHome, appBundlePath);
  const appMetadata: MacPackagedAppMetadata = {
    appBundlePath,
    bundleIdentifier,
    bundleExecutable: executableName,
    executablePath,
    executablePresent: true,
    executableIsExecutable: true,
    resourcesAppPath: appRootPath,
    packageName: packageData.name as string,
    packagePrivate: packageData.private as boolean,
    packageType: packageData.type as string,
    packageMain: packageData.main as string,
    daemonEntryPath,
    daemonEntryPresent: true,
    trayEntryPath,
    trayEntryPresent: true,
    helperPath,
    helperPresent: true,
  };
  const policy = createMacLaunchAgentPolicy({
    appMetadata,
    userHome,
    ...(tokeneloHome === undefined ? {} : { tokeneloHome }),
  });
  return { policy, uid };
}

function parseLaunchctlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      throw new Error('launchctl returned a malformed quoted value');
    }
  }
  return trimmed;
}

function parseLaunchctlArguments(lines: readonly string[], start: number): string[] {
  const values: string[] = [];
  let expectedIndex = 0;
  let entryStyle: 'indexed' | 'flat' | undefined;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === '  }') return values;
    if (line.trim() === '') continue;
    const entry = line.match(/^ {4}(?! )(.+)$/u);
    if (!entry) throw new Error('launchctl returned malformed arguments indentation');
    const text = entry[1];
    if (text === '}' || text.endsWith(' = {')) {
      throw new Error('launchctl returned nested argument structure');
    }
    const match = text.match(/^(\d+)\s*=\s*(.*)$/u);
    if (match) {
      if (entryStyle === 'flat') throw new Error('launchctl mixed indexed and flat arguments');
      entryStyle = 'indexed';
      if (Number(match[1]) !== expectedIndex) throw new Error('launchctl returned nonsequential arguments');
      expectedIndex++;
      values.push(parseLaunchctlValue(match[2]));
    } else {
      if (entryStyle === 'indexed') throw new Error('launchctl mixed indexed and flat arguments');
      entryStyle = 'flat';
      values.push(parseLaunchctlValue(text));
    }
  }
  throw new Error('launchctl returned an unterminated arguments block');
}

function parseLaunchctlEnvironment(lines: readonly string[], start: number): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === '  }') return values;
    if (line.trim() === '') continue;
    const entry = line.match(/^ {4}(?! )([A-Za-z_][A-Za-z0-9_]*)\s*(=>|=)\s*(.*)$/u);
    if (!entry) throw new Error('launchctl returned an unknown or nested environment entry');
    if (Object.hasOwn(values, entry[1])) throw new Error('launchctl returned a duplicate environment key');
    values[entry[1]] = parseLaunchctlValue(entry[3]);
  }
  throw new Error('launchctl returned an unterminated environment block');
}

export function parseLaunchctlPrint(
  output: string,
  expectedService?: string,
): Omit<MacLoadedLaunchAgent, never> {
  // launchctl documents `print` as human-readable output, not a stable automation API.
  // Keep this parser narrow and fail closed; a real-Mac qualification must confirm each
  // supported macOS version's output before this adapter is treated as lifecycle acceptance.
  const lines = output.split(/\r?\n/u);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (first >= lines.length || !/^gui\/\d+\/[A-Za-z0-9._-]+ = \{$/u.test(lines[first])) {
    throw new Error('launchctl output must contain exactly one gui service record');
  }
  if (expectedService !== undefined && lines[first] !== `${expectedService} = {`) {
    throw new Error('launchctl output service record does not match the requested uid and label');
  }

  const topLevel = new Set<string>();
  const scalarValues = new Map<string, string>();
  let parsedArguments: string[] | undefined;
  const environmentVariables: Record<string, string> = Object.create(null) as Record<string, string>;
  let outerClosed = false;
  let index = first + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (line === '}') {
      outerClosed = true;
      index++;
      break;
    }
    const field = line.match(/^ {2}(?! )(.+?) = (.*)$/u);
    if (!field || field[1] !== field[1].trim()) {
      throw new Error('launchctl returned malformed or nested top-level structure');
    }
    const name = field[1];
    if (topLevel.has(name)) throw new Error(`launchctl returned duplicate ${name} fields`);
    topLevel.add(name);
    const value = field[2];
    if (value === '{') {
      if (name === 'arguments') parsedArguments = parseLaunchctlArguments(lines, index);
      else if (name === 'environment') Object.assign(environmentVariables, parseLaunchctlEnvironment(lines, index));
      else throw new Error(`launchctl returned unsupported nested ${name} structure`);
      // The block parser returns at its closing brace. Resume after that line.
      let close = index + 1;
      while (close < lines.length && lines[close] !== '  }') close++;
      index = close;
    } else {
      if (name === 'arguments' || name === 'environment') {
        throw new Error(`launchctl ${name} field was not a block`);
      }
      scalarValues.set(name, parseLaunchctlValue(value));
    }
  }
  if (!outerClosed || lines.slice(index).some(line => line.trim() !== '')) {
    throw new Error('launchctl output must contain one fully closed service record');
  }
  for (const required of ['path', 'program', 'working directory']) {
    if (!scalarValues.has(required)) throw new Error(`launchctl output is missing ${required}`);
  }
  if (parsedArguments === undefined) throw new Error('launchctl output is missing arguments');
  const program = scalarValues.get('program')!;
  // The probed M4a launchctl record exposes full argv, including its executable; this is a
  // structural compatibility observation, not lifecycle acceptance across macOS versions.
  if (parsedArguments.length === 0 || parsedArguments[0] !== program) {
    throw new Error('launchctl arguments must contain the program as argv[0]');
  }
  return {
    plistPath: scalarValues.get('path')!,
    programArguments: parsedArguments,
    workingDirectory: scalarValues.get('working directory')!,
    environmentVariables,
  };
}

function launchctlBoundary(
  uid: number,
  host: MacPackagedRuntimeHost,
): MacLaunchAgentLifecycleIO['launchctl'] {
  const domain = `gui/${uid}`;
  const run = (args: readonly string[]): MacRuntimeCommandResult => host.execFile(
    '/bin/launchctl',
    args,
    { timeoutMs: MACOS_COMMAND_TIMEOUT_MS },
  );
  return {
    print(expectation: MacLaunchAgentExpectation): MacLoadedLaunchAgent | null {
      const label = expectation.definition.Label;
      const result = run(['print', `${domain}/${label}`]);
      if (result.timedOut) throw new Error(`launchctl print timed out for the ${label} LaunchAgent`);
      if (result.status !== 0) {
        if (/Could not find service\b/iu.test(result.stderr)) return null;
        throw new Error(`launchctl print failed for the ${label} LaunchAgent`);
      }
      const parsed = parseLaunchctlPrint(result.stdout, `${domain}/${label}`);
      const environmentVariables = { ...parsed.environmentVariables };
      // launchd adds this process label to the effective environment; it is not a plist key.
      if (environmentVariables.XPC_SERVICE_NAME === label) delete environmentVariables.XPC_SERVICE_NAME;
      return { ...parsed, environmentVariables };
    },
    bootout(expectation: MacLaunchAgentExpectation): void {
      const result = run(['bootout', domain, expectation.plistPath]);
      if (result.timedOut) throw new Error(`launchctl bootout timed out for the exact ${expectation.definition.Label} plist path`);
      if (result.status !== 0) throw new Error(`launchctl bootout failed for the exact ${expectation.definition.Label} plist path`);
    },
    bootstrap(expectation: MacLaunchAgentExpectation): void {
      const result = run(['bootstrap', domain, expectation.plistPath]);
      if (result.timedOut) throw new Error(`launchctl bootstrap timed out for ${expectation.definition.Label}`);
      if (result.status !== 0) throw new Error(`launchctl bootstrap failed for ${expectation.definition.Label}`);
    },
  };
}

export function runMacPackagedLaunchAgentLifecycle(
  input: ParsedPackagedLifecycleArguments,
  host: MacPackagedRuntimeHost,
): { operation: 'install' | 'uninstall'; recoveryPath?: string } {
  const { policy, uid } = validatePackagedRuntime(input, host);
  const result = runMacLaunchAgentLifecycle(policy, input.operation, uid, {
    fs: host.fs,
    launchctl: launchctlBoundary(uid, host),
  });
  return result;
}

function nodeLifecycleFileSystem(): MacLifecycleFileSystem {
  const status = (value: fs.Stats): MacLifecycleFileStatus => ({
    kind: value.isSymbolicLink() ? 'symlink' : value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
    uid: value.uid,
    mode: value.mode & 0o777,
  });
  return {
    lstat(value) {
      try { return status(fs.lstatSync(value)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    realpath(value) { return fs.realpathSync(value); },
    readFile(value) { return fs.readFileSync(value, 'utf8'); },
    writeFile(value, contents, mode, exclusive = false) {
      fs.writeFileSync(value, contents, { encoding: 'utf8', mode, flag: exclusive ? 'wx' : 'w' });
    },
    mkdir(value, mode) { fs.mkdirSync(value, { mode }); },
    rename(from, to) { fs.renameSync(from, to); },
    unlink(value) { fs.unlinkSync(value); },
    rmdir(value) { fs.rmdirSync(value); },
    chmod(value, mode) { fs.chmodSync(value, mode); },
    syncFile(value) {
      const descriptor = fs.openSync(value, 'r');
      try { fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    },
    syncDirectory(value) {
      const descriptor = fs.openSync(value, 'r');
      try { fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    },
  };
}

function nodeCommand(
  command: string,
  args: readonly string[],
  options: MacRuntimeCommandOptions,
): MacRuntimeCommandResult {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('macOS lifecycle child command requires a positive timeout');
  }
  try {
    const stdout = childProcess.execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MACOS_COMMAND_MAX_BUFFER_BYTES,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      status?: number | null;
      signal?: NodeJS.Signals | null;
      killed?: boolean;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    const timedOut = failure.code === 'ETIMEDOUT' || (failure.killed === true && failure.signal === 'SIGKILL');
    return {
      status: typeof failure.status === 'number' ? failure.status : timedOut ? 124 : 127,
      stdout: Buffer.isBuffer(failure.stdout) ? failure.stdout.toString('utf8') : String(failure.stdout ?? ''),
      stderr: Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : String(failure.stderr ?? ''),
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

function currentHost(runtimePath: string): MacPackagedRuntimeHost {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home: os.homedir(),
    accountHome: os.userInfo().homedir,
    environment: process.env,
    runtimePath,
    fs: nodeLifecycleFileSystem(),
    execFile: nodeCommand,
  };
}

function isDirectInvocation(runtimePath: string): boolean {
  return import.meta.url === pathToFileURL(path.resolve(runtimePath)).href;
}

function main(): number {
  try {
    const runtimePath = process.argv[1];
    if (!runtimePath || !isDirectInvocation(runtimePath)) return 0;
    const args = parseMacPackagedLifecycleArguments(process.argv.slice(2));
    const result = runMacPackagedLaunchAgentLifecycle(args, currentHost(runtimePath));
    process.stdout.write(result.recoveryPath
      ? `Tokenelo LaunchAgent ${result.operation} completed; recovery files retained at ${result.recoveryPath}\n`
      : `Tokenelo LaunchAgent ${result.operation} completed\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Tokenelo packaged LaunchAgent lifecycle failed: ${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && isDirectInvocation(process.argv[1])) process.exitCode = main();
