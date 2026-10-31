import path from 'node:path';

export const MACOS_TOKENELO_LABELS = Object.freeze({
  daemon: 'co.eloai.tokenelo.daemon',
  tray: 'co.eloai.tokenelo.tray',
} as const);

export const MACOS_TOKENELO_PACKAGE_CONTRACT = Object.freeze({
  appBundleName: 'Tokenelo.app',
  bundleIdentifier: 'com.elostudios.tokenelo',
  bundleExecutable: 'Tokenelo',
  packageName: 'tokenelo',
  packagePrivate: true,
  packageType: 'module',
  packageMain: 'dist/tray/main.js',
  daemonEntry: 'dist/daemon/main.js',
  trayEntry: 'dist/tray/main.js',
  helperEntry: 'scripts/install-service-macos.sh',
} as const);

const FIXED_LAUNCHD_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
const XML_HEADER = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
].join('\n');
const CONTROL_OR_NON_XML = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Read-only facts collected by a platform preflight. Paths must already be physical,
 * canonical POSIX paths; this module deliberately performs no filesystem inspection.
 */
export interface MacPackagedAppMetadata {
  appBundlePath: string;
  bundleIdentifier: string;
  bundleExecutable: string;
  executablePath: string;
  executablePresent: boolean;
  executableIsExecutable: boolean;
  resourcesAppPath: string;
  packageName: string;
  packagePrivate: boolean;
  packageType: string;
  packageMain: string;
  daemonEntryPath: string;
  daemonEntryPresent: boolean;
  trayEntryPath: string;
  trayEntryPresent: boolean;
  helperPath: string;
  helperPresent: boolean;
}

export interface MacPackagedAppPaths {
  appBundlePath: string;
  appRootPath: string;
  executablePath: string;
  daemonEntryPath: string;
  trayEntryPath: string;
  helperPath: string;
}

export interface MacDaemonLaunchAgent {
  Label: typeof MACOS_TOKENELO_LABELS.daemon;
  ProgramArguments: readonly [string, string];
  WorkingDirectory: string;
  RunAtLoad: true;
  KeepAlive: Readonly<{ SuccessfulExit: false }>;
  ProcessType: 'Standard';
  StandardOutPath: string;
  StandardErrorPath: string;
  EnvironmentVariables: Readonly<{
    PATH: typeof FIXED_LAUNCHD_PATH;
    ELECTRON_RUN_AS_NODE: '1';
    TOKENELO_HOME?: string;
  }>;
}

export interface MacTrayLaunchAgent {
  Label: typeof MACOS_TOKENELO_LABELS.tray;
  ProgramArguments: readonly ['/usr/bin/env', '-u', 'ELECTRON_RUN_AS_NODE', string];
  WorkingDirectory: string;
  RunAtLoad: true;
  LimitLoadToSessionType: 'Aqua';
  ProcessType: 'Interactive';
  StandardOutPath: string;
  StandardErrorPath: string;
  EnvironmentVariables: Readonly<{
    TOKENELO_HOME?: string;
  }>;
}

export type MacLaunchAgentDefinition = MacDaemonLaunchAgent | MacTrayLaunchAgent;

export interface MacLaunchAgentExpectation {
  plistPath: string;
  definition: MacLaunchAgentDefinition;
}

export interface MacLaunchAgentPolicy {
  userHome: string;
  tokeneloHome?: string;
  app: MacPackagedAppPaths;
  daemon: MacLaunchAgentExpectation;
  tray: MacLaunchAgentExpectation;
}

export interface MacLaunchAgentObservation {
  plistPath: string;
  plistText: string;
  loadedPath: string | null;
  programArguments: readonly string[];
  workingDirectory: string;
  environmentVariables: Readonly<Record<string, string>>;
}

export type MacLaunchAgentOwnership =
  | { state: 'missing'; reason: 'no-file-or-loaded-agent' }
  | { state: 'owned'; reason: 'exact-plist-and-action-match'; loaded: boolean }
  | {
      state: 'foreign';
      reason:
        | 'invalid-expectation'
        | 'unknown-observation-shape'
        | 'invalid-plist-path'
        | 'plist-path-mismatch'
        | 'plist-bytes-mismatch'
        | 'loaded-path-mismatch'
        | 'action-mismatch';
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (!hasExactKeys(value, keys)) throw new Error(label + ' has unknown or missing metadata');
}

function assertXmlSafeString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || CONTROL_OR_NON_XML.test(value)) {
    throw new Error(label + ' must be a string without XML control characters');
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint === 0xfffe || codePoint === 0xffff) {
      throw new Error(label + ' contains a character that XML 1.0 cannot represent');
    }
  }
}

function assertAbsoluteNormalizedPath(value: unknown, label: string): asserts value is string {
  assertXmlSafeString(value, label);
  if (
    value.length === 0 ||
    !path.posix.isAbsolute(value) ||
    value === '/' ||
    value.endsWith('/') ||
    value.includes('\\') ||
    path.posix.normalize(value) !== value ||
    value.split('/').filter(Boolean).length < 2
  ) {
    throw new Error(label + ' must be a normalized absolute POSIX path outside a filesystem root');
  }
}

function isWithinOrEqual(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + '/');
}

function validateTokeneloHome(tokeneloHome: unknown, userHome: string, appBundlePath: string): string | undefined {
  if (tokeneloHome === undefined) return undefined;
  assertAbsoluteNormalizedPath(tokeneloHome, 'TOKENELO_HOME');
  if (
    isWithinOrEqual(tokeneloHome, userHome) ||
    isWithinOrEqual(tokeneloHome, appBundlePath) ||
    isWithinOrEqual(appBundlePath, tokeneloHome)
  ) {
    throw new Error('TOKENELO_HOME must not alias a home/app root or overlap the application bundle');
  }
  return tokeneloHome;
}

function validateMetadata(value: unknown): MacPackagedAppMetadata {
  if (!isPlainRecord(value)) throw new Error('macOS package metadata must be a plain object');
  assertExactKeys(
    value,
    [
      'appBundlePath', 'bundleIdentifier', 'bundleExecutable', 'resourcesAppPath',
      'executablePath', 'executablePresent', 'executableIsExecutable',
      'packageName', 'packagePrivate', 'packageType', 'packageMain',
      'daemonEntryPath', 'daemonEntryPresent', 'trayEntryPath', 'trayEntryPresent',
      'helperPath', 'helperPresent',
    ],
    'macOS package metadata',
  );

  assertAbsoluteNormalizedPath(value.appBundlePath, 'appBundlePath');
  if (
    path.posix.basename(value.appBundlePath) !== MACOS_TOKENELO_PACKAGE_CONTRACT.appBundleName ||
    path.posix.dirname(value.appBundlePath) === '/'
  ) {
    throw new Error('appBundlePath must name a non-root Tokenelo.app bundle');
  }

  const expectedRoot = path.posix.join(value.appBundlePath, 'Contents', 'Resources', 'app');
  const expectedExecutable = path.posix.join(value.appBundlePath, 'Contents', 'MacOS', MACOS_TOKENELO_PACKAGE_CONTRACT.bundleExecutable);
  const expectedDaemonEntry = path.posix.join(expectedRoot, MACOS_TOKENELO_PACKAGE_CONTRACT.daemonEntry);
  const expectedTrayEntry = path.posix.join(expectedRoot, MACOS_TOKENELO_PACKAGE_CONTRACT.trayEntry);
  const expectedHelper = path.posix.join(expectedRoot, MACOS_TOKENELO_PACKAGE_CONTRACT.helperEntry);

  assertAbsoluteNormalizedPath(value.resourcesAppPath, 'resourcesAppPath');
  assertAbsoluteNormalizedPath(value.executablePath, 'executablePath');
  assertAbsoluteNormalizedPath(value.daemonEntryPath, 'daemonEntryPath');
  assertAbsoluteNormalizedPath(value.trayEntryPath, 'trayEntryPath');
  assertAbsoluteNormalizedPath(value.helperPath, 'helperPath');

  if (
    value.bundleIdentifier !== MACOS_TOKENELO_PACKAGE_CONTRACT.bundleIdentifier ||
    value.bundleExecutable !== MACOS_TOKENELO_PACKAGE_CONTRACT.bundleExecutable ||
    value.executablePath !== expectedExecutable ||
    value.executablePresent !== true ||
    value.executableIsExecutable !== true ||
    value.resourcesAppPath !== expectedRoot ||
    value.packageName !== MACOS_TOKENELO_PACKAGE_CONTRACT.packageName ||
    value.packagePrivate !== MACOS_TOKENELO_PACKAGE_CONTRACT.packagePrivate ||
    value.packageType !== MACOS_TOKENELO_PACKAGE_CONTRACT.packageType ||
    value.packageMain !== MACOS_TOKENELO_PACKAGE_CONTRACT.packageMain ||
    value.daemonEntryPath !== expectedDaemonEntry ||
    value.trayEntryPath !== expectedTrayEntry ||
    value.helperPath !== expectedHelper ||
    value.daemonEntryPresent !== true ||
    value.trayEntryPresent !== true ||
    value.helperPresent !== true
  ) {
    throw new Error('macOS app bundle does not match the private Tokenelo package contract');
  }

  return value as unknown as MacPackagedAppMetadata;
}

function freezeDefinition<T extends MacLaunchAgentDefinition>(definition: T): T {
  Object.freeze(definition.ProgramArguments);
  Object.freeze(definition.EnvironmentVariables);
  if ('KeepAlive' in definition) Object.freeze(definition.KeepAlive);
  return Object.freeze(definition);
}

export function createMacLaunchAgentPolicy(input: unknown): MacLaunchAgentPolicy {
  if (!isPlainRecord(input)) throw new Error('macOS LaunchAgent policy input must be a plain object');
  const allowedKeys = input.tokeneloHome === undefined
    ? ['appMetadata', 'userHome']
    : ['appMetadata', 'userHome', 'tokeneloHome'];
  assertExactKeys(input, allowedKeys, 'macOS LaunchAgent policy input');

  const appMetadata = validateMetadata(input.appMetadata);
  assertAbsoluteNormalizedPath(input.userHome, 'userHome');
  if (path.posix.dirname(input.userHome) === '/') throw new Error('userHome cannot be a filesystem-root alias');
  const tokeneloHome = validateTokeneloHome(input.tokeneloHome, input.userHome, appMetadata.appBundlePath);
  const appRootPath = appMetadata.resourcesAppPath;
  const executablePath = path.posix.join(appMetadata.appBundlePath, 'Contents', 'MacOS', MACOS_TOKENELO_PACKAGE_CONTRACT.bundleExecutable);
  const app: MacPackagedAppPaths = Object.freeze({
    appBundlePath: appMetadata.appBundlePath,
    appRootPath,
    executablePath,
    daemonEntryPath: appMetadata.daemonEntryPath,
    trayEntryPath: appMetadata.trayEntryPath,
    helperPath: appMetadata.helperPath,
  });

  const logs = path.posix.join(input.userHome, 'Library', 'Logs', 'Tokenelo');
  const daemonEnvironment = Object.freeze({
    PATH: FIXED_LAUNCHD_PATH,
    ELECTRON_RUN_AS_NODE: '1' as const,
    ...(tokeneloHome === undefined ? {} : { TOKENELO_HOME: tokeneloHome }),
  });
  const trayEnvironment = Object.freeze({
    ...(tokeneloHome === undefined ? {} : { TOKENELO_HOME: tokeneloHome }),
  });
  const daemon = freezeDefinition({
    Label: MACOS_TOKENELO_LABELS.daemon,
    ProgramArguments: Object.freeze([executablePath, appMetadata.daemonEntryPath] as const),
    WorkingDirectory: appRootPath,
    RunAtLoad: true,
    KeepAlive: Object.freeze({ SuccessfulExit: false as const }),
    ProcessType: 'Standard',
    StandardOutPath: path.posix.join(logs, 'daemon.out.log'),
    StandardErrorPath: path.posix.join(logs, 'daemon.err.log'),
    EnvironmentVariables: daemonEnvironment,
  } satisfies MacDaemonLaunchAgent);
  const tray = freezeDefinition({
    Label: MACOS_TOKENELO_LABELS.tray,
    ProgramArguments: Object.freeze(['/usr/bin/env', '-u', 'ELECTRON_RUN_AS_NODE', executablePath] as const),
    WorkingDirectory: appRootPath,
    RunAtLoad: true,
    LimitLoadToSessionType: 'Aqua',
    ProcessType: 'Interactive',
    StandardOutPath: path.posix.join(logs, 'tray.out.log'),
    StandardErrorPath: path.posix.join(logs, 'tray.err.log'),
    EnvironmentVariables: trayEnvironment,
  } satisfies MacTrayLaunchAgent);

  return Object.freeze({
    userHome: input.userHome,
    ...(tokeneloHome === undefined ? {} : { tokeneloHome }),
    app,
    daemon: Object.freeze({
      plistPath: path.posix.join(input.userHome, 'Library', 'LaunchAgents', MACOS_TOKENELO_LABELS.daemon + '.plist'),
      definition: daemon,
    }),
    tray: Object.freeze({
      plistPath: path.posix.join(input.userHome, 'Library', 'LaunchAgents', MACOS_TOKENELO_LABELS.tray + '.plist'),
      definition: tray,
    }),
  });
}

export function escapeMacPlistString(value: string): string {
  assertXmlSafeString(value, 'plist value');
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function validateDefinition(value: unknown): MacLaunchAgentDefinition {
  if (!isPlainRecord(value)) throw new Error('LaunchAgent definition must be a plain object');
  const label = value.Label;
  if (label === MACOS_TOKENELO_LABELS.daemon) {
    assertExactKeys(value, [
      'Label', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive', 'ProcessType',
      'StandardOutPath', 'StandardErrorPath', 'EnvironmentVariables',
    ], 'daemon LaunchAgent definition');
    if (
      value.RunAtLoad !== true ||
      value.ProcessType !== 'Standard' ||
      !isPlainRecord(value.KeepAlive) ||
      !hasExactKeys(value.KeepAlive, ['SuccessfulExit']) ||
      value.KeepAlive.SuccessfulExit !== false
    ) {
      throw new Error('daemon LaunchAgent settings do not match policy');
    }
  } else if (label === MACOS_TOKENELO_LABELS.tray) {
    assertExactKeys(value, [
      'Label', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'LimitLoadToSessionType', 'ProcessType',
      'StandardOutPath', 'StandardErrorPath', 'EnvironmentVariables',
    ], 'tray LaunchAgent definition');
    if (value.RunAtLoad !== true || value.ProcessType !== 'Interactive' || value.LimitLoadToSessionType !== 'Aqua') {
      throw new Error('tray LaunchAgent settings do not match policy');
    }
  } else {
    throw new Error('LaunchAgent label is not a Tokenelo label');
  }

  if (!Array.isArray(value.ProgramArguments) || value.ProgramArguments.some(argument => typeof argument !== 'string')) {
    throw new Error('LaunchAgent ProgramArguments must be an array of strings');
  }
  const argumentsList = value.ProgramArguments as string[];
  const daemon = label === MACOS_TOKENELO_LABELS.daemon;
  if (argumentsList.length !== (daemon ? 2 : 4)) {
    throw new Error('LaunchAgent ProgramArguments have the wrong role shape');
  }
  const executablePath = daemon ? argumentsList[0] : argumentsList[3];
  assertAbsoluteNormalizedPath(executablePath, 'LaunchAgent executable path');
  if (
    !daemon &&
    (argumentsList[0] !== '/usr/bin/env' ||
      argumentsList[1] !== '-u' ||
      argumentsList[2] !== 'ELECTRON_RUN_AS_NODE')
  ) {
    throw new Error('tray must clear Electron Node mode with the exact env argv');
  }
  if (daemon) assertAbsoluteNormalizedPath(argumentsList[1], 'daemon entry path');

  assertAbsoluteNormalizedPath(value.WorkingDirectory, 'WorkingDirectory');

  assertAbsoluteNormalizedPath(value.StandardOutPath, 'StandardOutPath');
  assertAbsoluteNormalizedPath(value.StandardErrorPath, 'StandardErrorPath');
  if (
    !value.StandardOutPath.endsWith('/Library/Logs/Tokenelo/' + (label === MACOS_TOKENELO_LABELS.daemon ? 'daemon' : 'tray') + '.out.log') ||
    !value.StandardErrorPath.endsWith('/Library/Logs/Tokenelo/' + (label === MACOS_TOKENELO_LABELS.daemon ? 'daemon' : 'tray') + '.err.log')
  ) {
    throw new Error('LaunchAgent logs must stay in the per-user Tokenelo log directory');
  }

  if (!isPlainRecord(value.EnvironmentVariables)) throw new Error('EnvironmentVariables must be a plain object');
  const environment = value.EnvironmentVariables;
  const expectedEnvironmentKeys = daemon
    ? (Object.hasOwn(environment, 'TOKENELO_HOME') ? ['PATH', 'ELECTRON_RUN_AS_NODE', 'TOKENELO_HOME'] : ['PATH', 'ELECTRON_RUN_AS_NODE'])
    : (Object.hasOwn(environment, 'TOKENELO_HOME') ? ['TOKENELO_HOME'] : []);
  assertExactKeys(environment, expectedEnvironmentKeys, 'LaunchAgent EnvironmentVariables');
  for (const [key, envValue] of Object.entries(environment)) {
    assertXmlSafeString(key, 'EnvironmentVariables key');
    assertXmlSafeString(envValue, 'EnvironmentVariables.' + key);
  }
  if (
    (daemon && environment.ELECTRON_RUN_AS_NODE !== '1') ||
    (!daemon && Object.hasOwn(environment, 'ELECTRON_RUN_AS_NODE')) ||
    (daemon && environment.PATH !== FIXED_LAUNCHD_PATH)
  ) {
    throw new Error('LaunchAgent Electron runtime mode does not match role policy');
  }
  const bundleRoot = path.posix.dirname(path.posix.dirname(path.posix.dirname(executablePath)));
  const expectedAppRoot = path.posix.join(bundleRoot, 'Contents', 'Resources', 'app');
  if (
    path.posix.basename(bundleRoot) !== MACOS_TOKENELO_PACKAGE_CONTRACT.appBundleName ||
    executablePath !== path.posix.join(bundleRoot, 'Contents', 'MacOS', MACOS_TOKENELO_PACKAGE_CONTRACT.bundleExecutable) ||
    value.WorkingDirectory !== expectedAppRoot ||
    (daemon &&
      argumentsList[1] !== path.posix.join(bundleRoot, 'Contents', 'Resources', 'app', MACOS_TOKENELO_PACKAGE_CONTRACT.daemonEntry))
  ) {
    throw new Error('LaunchAgent action does not use the adjacent packaged Tokenelo runtime');
  }

  const role = daemon ? 'daemon' : 'tray';
  const logSuffix = '/Library/Logs/Tokenelo/' + role + '.out.log';
  const errorSuffix = '/Library/Logs/Tokenelo/' + role + '.err.log';
  const userHome = value.StandardOutPath.slice(0, -logSuffix.length);
  const errorHome = value.StandardErrorPath.slice(0, -errorSuffix.length);
  assertAbsoluteNormalizedPath(userHome, 'LaunchAgent user home');
  if (
    !value.StandardOutPath.endsWith(logSuffix) ||
    !value.StandardErrorPath.endsWith(errorSuffix) ||
    userHome !== errorHome ||
    path.posix.dirname(userHome) === '/'
  ) {
    throw new Error('LaunchAgent logs must resolve beneath one safe user home');
  }
  if (Object.hasOwn(environment, 'TOKENELO_HOME')) {
    validateTokeneloHome(environment.TOKENELO_HOME, userHome, bundleRoot);
  }

  return value as unknown as MacLaunchAgentDefinition;
}

function plistStringElement(value: string, indent: string): string {
  return indent + '<string>' + escapeMacPlistString(value) + '</string>';
}

export function serializeMacLaunchAgentPlist(definitionInput: MacLaunchAgentDefinition): string {
  const definition = validateDefinition(definitionInput);
  const daemon = definition.Label === MACOS_TOKENELO_LABELS.daemon;
  const lines = [
    XML_HEADER,
    '<dict>',
    '    <key>Label</key>',
    plistStringElement(definition.Label, '    '),
    '    <key>ProgramArguments</key>',
    '    <array>',
    ...definition.ProgramArguments.map(argument => plistStringElement(argument, '        ')),
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
  ];

  if (daemon) {
    lines.push(
      '    <key>KeepAlive</key>',
      '    <dict>',
      '        <key>SuccessfulExit</key>',
      '        <false/>',
      '    </dict>',
    );
  } else {
    lines.push(
      '    <key>LimitLoadToSessionType</key>',
      plistStringElement('Aqua', '    '),
    );
  }

  lines.push(
    '    <key>WorkingDirectory</key>',
    plistStringElement(definition.WorkingDirectory, '    '),
    '    <key>ProcessType</key>',
    plistStringElement(definition.ProcessType, '    '),
    '    <key>StandardOutPath</key>',
    plistStringElement(definition.StandardOutPath, '    '),
    '    <key>StandardErrorPath</key>',
    plistStringElement(definition.StandardErrorPath, '    '),
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
  );

  const environmentOrder = daemon
    ? ['PATH', 'ELECTRON_RUN_AS_NODE', 'TOKENELO_HOME']
    : ['TOKENELO_HOME'];
  for (const key of environmentOrder) {
    const environmentValue = definition.EnvironmentVariables[key as keyof typeof definition.EnvironmentVariables];
    if (environmentValue === undefined) continue;
    lines.push(
      '        <key>' + escapeMacPlistString(key) + '</key>',
      plistStringElement(environmentValue, '        '),
    );
  }

  lines.push('    </dict>', '</dict>', '</plist>', '');
  return lines.join('\n');
}

function canonicalJson(value: unknown): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const children = value.map(canonicalJson);
    return children.some(child => child === null) ? null : '[' + children.join(',') + ']';
  }
  if (!isPlainRecord(value)) return null;
  const entries = Object.keys(value).sort().map(key => {
    const child = canonicalJson(value[key]);
    return child === null ? null : JSON.stringify(key) + ':' + child;
  });
  return entries.some(entry => entry === null) ? null : '{' + entries.join(',') + '}';
}

export function classifyMacLaunchAgentOwnership(
  expectedInput: MacLaunchAgentExpectation,
  observedInput: unknown,
): MacLaunchAgentOwnership {
  if (!isPlainRecord(expectedInput) || !hasExactKeys(expectedInput, ['plistPath', 'definition'])) {
    return { state: 'foreign', reason: 'invalid-expectation' };
  }
  let expectedPath: string;
  let expectedPlist: string;
  let expectedDefinition: MacLaunchAgentDefinition;
  try {
    assertAbsoluteNormalizedPath(expectedInput.plistPath, 'expected plistPath');
    expectedDefinition = validateDefinition(expectedInput.definition);
    expectedPath = expectedInput.plistPath;
    const role = expectedDefinition.Label === MACOS_TOKENELO_LABELS.daemon ? 'daemon' : 'tray';
    const logSuffix = '/Library/Logs/Tokenelo/' + role + '.out.log';
    const userHome = expectedDefinition.StandardOutPath.slice(0, -logSuffix.length);
    const requiredPath = path.posix.join(userHome, 'Library', 'LaunchAgents', expectedDefinition.Label + '.plist');
    if (expectedPath !== requiredPath) throw new Error('expected plist path does not match role label and user home');
    expectedPlist = serializeMacLaunchAgentPlist(expectedDefinition);
  } catch {
    return { state: 'foreign', reason: 'invalid-expectation' };
  }

  if (observedInput === null) return { state: 'missing', reason: 'no-file-or-loaded-agent' };
  if (!isPlainRecord(observedInput) || !hasExactKeys(
    observedInput,
    ['plistPath', 'plistText', 'loadedPath', 'programArguments', 'workingDirectory', 'environmentVariables'],
  )) {
    return { state: 'foreign', reason: 'unknown-observation-shape' };
  }

  try {
    assertAbsoluteNormalizedPath(observedInput.plistPath, 'observed plistPath');
    if (observedInput.loadedPath !== null) assertAbsoluteNormalizedPath(observedInput.loadedPath, 'observed loadedPath');
  } catch {
    return { state: 'foreign', reason: 'invalid-plist-path' };
  }
  if (observedInput.plistPath !== expectedPath) return { state: 'foreign', reason: 'plist-path-mismatch' };
  if (typeof observedInput.plistText !== 'string' || observedInput.plistText !== expectedPlist) {
    return { state: 'foreign', reason: 'plist-bytes-mismatch' };
  }
  if (observedInput.loadedPath !== null && observedInput.loadedPath !== expectedPath) {
    return { state: 'foreign', reason: 'loaded-path-mismatch' };
  }

  const expectedAction = {
    programArguments: expectedDefinition.ProgramArguments,
    workingDirectory: expectedDefinition.WorkingDirectory,
    environmentVariables: expectedDefinition.EnvironmentVariables,
  };
  const observedAction = {
    programArguments: observedInput.programArguments,
    workingDirectory: observedInput.workingDirectory,
    environmentVariables: observedInput.environmentVariables,
  };
  if (canonicalJson(expectedAction) === null || canonicalJson(expectedAction) !== canonicalJson(observedAction)) {
    return { state: 'foreign', reason: 'action-mismatch' };
  }

  return {
    state: 'owned',
    reason: 'exact-plist-and-action-match',
    loaded: observedInput.loadedPath === expectedPath,
  };
}
