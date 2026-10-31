import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectDistManifest } from './write-build-identity.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_PATHS = [
  'dist/tray/main.js',
  'dist/tray/preload.js',
  'dist/tray/renderer/index.html',
  'dist/daemon/main.js',
  'dist/daemon/report-process-entry.js',
  'dist/daemon/report-worker.js',
  'dist/daemon/native/report-job-host.exe',
  'rates/prices.json',
  'scripts/install-service-windows.ps1',
  'scripts/install-service-macos.sh',
  'scripts/windows/TokeneloHiddenLauncher.cs',
];
const PACKAGE_SUPPORT_FILES = [
  'scripts/install-service-windows.ps1',
  'scripts/install-service-macos.sh',
  'scripts/windows/TokeneloHiddenLauncher.cs',
];
const RATE_ALLOWLIST = new Set([
  'prices.json',
]);
const DIST_ALLOWED_EXTENSIONS = new Set(['.js', '.map', '.json', '.exe', '.css', '.html']);
const DIST_CODE_NAME_EXCEPTIONS = new Set([
  'core/token-counts.js', 'core/token-counts.js.map',
  'core/token-field-evidence.js', 'core/token-field-evidence.js.map',
  'store/db.js', 'store/db.js.map',
  'daemon/config.js', 'daemon/config.js.map',
]);
const DIST_SENSITIVE_NAME = /(?:^|[._-])(?:\.?env|secrets?|credentials?|tokens?|database|db|api[-_]?key|private[-_]?key|wallet|ledger|config(?:uration)?|source|src)(?=$|[._-])/i;
const PACKAGE_MAIN = 'dist/tray/main.js';
const FIXED_TIME = new Date('2000-01-01T00:00:00.000Z');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJson(filePath, label) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`${label} is missing or invalid JSON: ${error.message}`); }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(`Git verification failed (${args.join(' ')}): ${detail || error.message}`);
  }
}

function resolveThroughExistingParent(candidate) {
  const missing = [];
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve output path parent: ${candidate}`);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...missing);
}

function assertSafeTree(root, label) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch { throw new Error(`${label} is missing`); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);

  const files = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const fullPath = path.join(directory, name);
      const stat = fs.lstatSync(fullPath);
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) { walk(fullPath); continue; }
      if (!stat.isFile()) throw new Error(`${label} contains a non-regular entry: ${relativePath}`);
      const bytes = fs.readFileSync(fullPath);
      files.push({ path: relativePath, sizeBytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  walk(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function assertRequiredPaths(repositoryRoot) {
  for (const relativePath of REQUIRED_PATHS) {
    const fullPath = path.join(repositoryRoot, ...relativePath.split('/'));
    let stat;
    try { stat = fs.lstatSync(fullPath); }
    catch { throw new Error(`Required package payload is missing: ${relativePath}`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Required package payload is not a regular file: ${relativePath}`);
  }
}

function collectPackageSupportFiles(repositoryRoot) {
  return PACKAGE_SUPPORT_FILES.map(relativePath => {
    let currentPath = repositoryRoot;
    const parts = relativePath.split('/');
    for (let index = 0; index < parts.length; index++) {
      currentPath = path.join(currentPath, parts[index]);
      let stat;
      try { stat = fs.lstatSync(currentPath); }
      catch { throw new Error(`Required package payload is missing: ${relativePath}`); }
      if (stat.isSymbolicLink()) throw new Error(`Package support payload contains a symbolic link: ${relativePath}`);
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`Package support payload parent is not a directory: ${relativePath}`);
      }
      if (index === parts.length - 1 && !stat.isFile()) {
        throw new Error(`Required package payload is not a regular file: ${relativePath}`);
      }
    }
    const bytes = fs.readFileSync(currentPath);
    return { path: relativePath, sizeBytes: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertAllowedDistFiles(files) {
  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const extension = path.posix.extname(lowerPath);
    if (!DIST_ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`dist contains a non-runtime or source payload extension: ${file.path}`);
    }
    const fileName = path.posix.basename(lowerPath);
    if (fileName.startsWith('.env') || /(?:^|\/)\.env(?:\.|$)/i.test(lowerPath)) {
      throw new Error(`dist contains a forbidden environment payload: ${file.path}`);
    }
    if (DIST_SENSITIVE_NAME.test(lowerPath) && !DIST_CODE_NAME_EXCEPTIONS.has(lowerPath)) {
      throw new Error(`dist contains a forbidden sensitive-name payload: ${file.path}`);
    }
  }
}

function assertAllowedRateFiles(files, ratesRoot) {
  const placeholderPath = path.join(ratesRoot, '.gitkeep');
  let placeholderStat = null;
  try { placeholderStat = fs.lstatSync(placeholderPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (placeholderStat && (!placeholderStat.isFile() || placeholderStat.isSymbolicLink())) {
    throw new Error('rates/.gitkeep may only be an empty regular metadata file');
  }
  if (placeholderStat && placeholderStat.size !== 0) throw new Error('rates/.gitkeep is tracked metadata and must be empty');
  const metadata = files.filter(file => file.path === '.gitkeep');
  if (metadata.some(file => file.sizeBytes !== 0)) throw new Error('rates/.gitkeep is tracked metadata and must be empty');
  const payloadFiles = files.filter(file => file.path !== '.gitkeep');
  const actual = payloadFiles.map(file => file.path).sort();
  const allowed = [...RATE_ALLOWLIST].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    const unexpected = actual.filter(file => !RATE_ALLOWLIST.has(file));
    const missing = allowed.filter(file => !actual.includes(file));
    throw new Error(`rates payload must exactly match its one-file allowlist; unexpected=[${unexpected.join(', ')}], missing=[${missing.join(', ')}]`);
  }
  return payloadFiles;
}

function importSpecifiers(sourceText) {
  const specifiers = new Set();
  const declarations = sourceText.matchAll(/^[ \t]*(?:import|export)\b[^;]*;/gm);
  for (const declaration of declarations) {
    const statement = declaration[0];
    const from = statement.match(/\bfrom\s*(['"])([^'"]+)\1/);
    const sideEffect = statement.match(/^\s*import\s*(['"])([^'"]+)\1/);
    if (from) specifiers.add(from[2]);
    else if (sideEffect) specifiers.add(sideEffect[2]);
  }
  for (const dynamicImport of sourceText.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    specifiers.add(dynamicImport[2]);
  }
  return specifiers;
}

function resolveTypeScriptImport(importer, specifier, sourceFiles) {
  if (!specifier.startsWith('.')) return null;
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const extension = path.posix.extname(normalized);
  const candidates = extension === '.js'
    ? [`${normalized.slice(0, -3)}.ts`, `${normalized.slice(0, -3)}.d.ts`]
    : extension === '' ? [`${normalized}.ts`, `${normalized}/index.ts`] : [normalized];
  return candidates.find(candidate => sourceFiles.has(candidate) && !candidate.endsWith('.d.ts')) ?? null;
}

function expectedDistPaths(repositoryRoot) {
  const tsconfig = readJson(path.join(repositoryRoot, 'tsconfig.json'), 'tsconfig.json');
  const options = tsconfig.compilerOptions ?? {};
  if (options.rootDir !== 'src'
    || options.outDir !== 'dist'
    || options.sourceMap !== true
    || options.declaration !== false
    || options.noEmit === true
    || !tsconfig.include?.includes('src/**/*')
    || !tsconfig.exclude?.includes('src/tray/renderer/**')) {
    throw new Error('tsconfig.json no longer matches the supported source-to-dist packaging contract');
  }

  const trackedPaths = git(repositoryRoot, ['ls-files', '--', 'src']).split(/\r?\n/).filter(Boolean);
  const unsupportedSources = trackedPaths.filter(file => /^src\/.*\.(?:tsx|mts|cts)$/i.test(file));
  if (unsupportedSources.length) throw new Error(`Unsupported TypeScript emit source extension: ${unsupportedSources.join(', ')}`);
  const sources = new Set(trackedPaths.filter(file => /^src\/.*\.ts$/i.test(file) && !file.endsWith('.d.ts')));
  const rendererPrefix = 'src/tray/renderer/';
  const roots = [...sources].filter(file => !file.startsWith(rendererPrefix));
  if (!roots.length) throw new Error('No committed non-renderer TypeScript source inputs were found');

  // tsc emits every non-renderer src input plus local TypeScript dependencies pulled into its program,
  // including type-only renderer modules. Derive that dependency closure from committed source bytes.
  const emittedSources = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const importer = queue.pop();
    const sourceText = fs.readFileSync(path.join(repositoryRoot, ...importer.split('/')), 'utf8');
    for (const specifier of importSpecifiers(sourceText)) {
      const resolved = resolveTypeScriptImport(importer, specifier, sources);
      if (resolved && !emittedSources.has(resolved)) {
        emittedSources.add(resolved);
        queue.push(resolved);
      }
    }
  }

  const expected = new Set(['package-manifest.json', 'daemon/build-identity.json', 'daemon/native/report-job-host.exe']);
  for (const source of emittedSources) {
    const relative = source.slice('src/'.length, -'.ts'.length);
    const javascript = `${relative}.js`;
    expected.add(javascript);
    expected.add(`${javascript}.map`);
  }

  for (const entry of ['app', 'detail']) {
    const source = `src/tray/renderer/${entry}.ts`;
    if (sources.has(source)) {
      const output = `tray/renderer/${entry}.js`;
      expected.add(output);
      expected.add(`${output}.map`);
    }
  }
  for (const asset of ['index.html', 'styles.css', 'detail.html', 'detail.css']) {
    const source = `src/tray/renderer/${asset}`;
    if (trackedPaths.includes(source)) expected.add(`tray/renderer/${asset}`);
  }
  return expected;
}

function assertExpectedDistPaths(repositoryRoot, actualFiles) {
  const expected = expectedDistPaths(repositoryRoot);
  const actual = actualFiles.map(file => file.path).sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedSorted)) {
    const expectedSet = new Set(expectedSorted);
    const actualSet = new Set(actual);
    const unexpected = actual.filter(file => !expectedSet.has(file));
    const missing = expectedSorted.filter(file => !actualSet.has(file));
    throw new Error(`dist paths must match outputs derived from committed source and explicit assets; unexpected=[${unexpected.join(', ')}], missing=[${missing.join(', ')}]`);
  }
}

function packageToolchain(repositoryRoot) {
  const sourcePackage = readJson(path.join(repositoryRoot, 'package.json'), 'Source package.json');
  if (sourcePackage.private !== true) throw new Error('Source package.json must keep private: true');
  if (typeof sourcePackage.name !== 'string' || typeof sourcePackage.version !== 'string') {
    throw new Error('Source package name and version are required');
  }
  if (sourcePackage.type !== 'module') throw new Error('Source package.json must keep type: module for the compiled Electron entrypoint');
  const lock = readJson(path.join(repositoryRoot, 'package-lock.json'), 'package-lock.json');
  const builderVersion = lock.packages?.['node_modules/electron-builder']?.version;
  const declaredBuilderVersion = sourcePackage.devDependencies?.['electron-builder'];
  if (builderVersion !== '26.18.0'
    || declaredBuilderVersion !== builderVersion
    || lock.packages?.['']?.devDependencies?.['electron-builder'] !== builderVersion) {
    throw new Error('electron-builder must be pinned exactly to the verified v26 patch 26.18.0 in package.json and package-lock.json');
  }
  const electronVersion = lock.packages?.['node_modules/electron']?.version;
  if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
    throw new Error('The locked Electron runtime version is missing or invalid');
  }
  if (typeof sourcePackage.devDependencies?.electron !== 'string') {
    throw new Error('Electron must be declared in source devDependencies and locked');
  }
  return { sourcePackage, builderVersion, electronVersion };
}

function verifiedSource(repositoryRoot) {
  const actualGitRoot = path.resolve(git(repositoryRoot, ['rev-parse', '--show-toplevel']));
  const realSourceRoot = fs.realpathSync(repositoryRoot);
  const realGitRoot = fs.realpathSync(actualGitRoot);
  const rootsMatch = process.platform === 'win32'
    ? realSourceRoot.toLowerCase() === realGitRoot.toLowerCase()
    : realSourceRoot === realGitRoot;
  if (!rootsMatch) throw new Error('Package staging must run from the Git worktree root');
  const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error('Source HEAD is not a full Git object ID');
  const status = git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)dist']);
  if (status.length > 0) throw new Error(`Source tree is dirty outside generated dist:\n${status}`);

  const distRoot = path.join(repositoryRoot, 'dist');
  const distFiles = assertSafeTree(distRoot, 'dist payload');
  assertAllowedDistFiles(distFiles);
  assertExpectedDistPaths(repositoryRoot, distFiles);
  const calculatedDist = collectDistManifest(distRoot);
  const packageManifestPath = path.join(distRoot, 'package-manifest.json');
  let savedManifest;
  try { savedManifest = fs.readFileSync(packageManifestPath, 'utf8'); }
  catch { throw new Error('Built dist/package-manifest.json is missing'); }
  if (savedManifest !== calculatedDist.content) throw new Error('Built dist payload does not match dist/package-manifest.json');

  const identity = readJson(path.join(distRoot, 'daemon', 'build-identity.json'), 'dist/daemon/build-identity.json');
  if (identity.schemaVersion !== 1
    || identity.sourceRevision !== head
    || identity.sourceDirty !== false
    || identity.distManifestSha256 !== calculatedDist.sha256) {
    throw new Error('Build identity is not a clean, current-HEAD identity for the verified dist payload');
  }
  assertRequiredPaths(repositoryRoot);
  const ratesRoot = path.join(repositoryRoot, 'rates');
  const ratesFiles = assertAllowedRateFiles(assertSafeTree(ratesRoot, 'rates payload'), ratesRoot);
  const packageSupportFiles = collectPackageSupportFiles(repositoryRoot);
  return { head, identity, calculatedDist, distFiles, ratesFiles, packageSupportFiles };
}

function normalizeTimes(root) {
  const directories = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const fullPath = path.join(directory, name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) { walk(fullPath); directories.push(fullPath); }
      else if (stat.isFile()) fs.utimesSync(fullPath, FIXED_TIME, FIXED_TIME);
      else throw new Error(`Staged package contains a non-regular entry: ${path.relative(root, fullPath)}`);
    }
  }
  walk(root);
  for (const directory of directories) fs.utimesSync(directory, FIXED_TIME, FIXED_TIME);
  fs.utimesSync(root, FIXED_TIME, FIXED_TIME);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertPhysicalObject(root, candidate, label) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(candidate);
  if (!isInside(rootPath, targetPath)) throw new Error(label + ' escaped its owned tree');
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(fs.realpathSync(rootPath), rootPath)) {
    throw new Error(label + ' root must be a physical directory');
  }
  let current = rootPath;
  let stat = rootStat;
  const relative = path.relative(rootPath, targetPath);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(label + ' contains a symbolic link');
    if (current !== targetPath && !stat.isDirectory()) throw new Error(label + ' parent is not a directory');
    if (!samePath(fs.realpathSync(current), current)) throw new Error(label + ' is not physically contained');
  }
  return stat;
}

function assertStagedOwner(stat, label) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(label + ' is not owned by the staging process');
  }
}

function assertStagedMode(stat, expectedMode, label) {
  if (process.platform !== 'win32' && (stat.mode & 0o7777) !== expectedMode) {
    throw new Error(label + ' mode must be ' + expectedMode.toString(8));
  }
}

function assertStagedEntry(root, candidate, kind, mode, label) {
  const stat = assertPhysicalObject(root, candidate, label);
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw new Error(label + ' must be a regular ' + kind);
  }
  assertStagedOwner(stat, label);
  assertStagedMode(stat, mode, label);
  return stat;
}

function ensureStagedDirectory(root, target, mode) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  if (!isInside(rootPath, targetPath)) throw new Error('Staged directory escaped its output root');
  const relative = path.relative(rootPath, targetPath);
  let current = rootPath;
  if (relative === '') return assertStagedEntry(rootPath, rootPath, 'directory', mode, 'staged directory');
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let created = false;
    try { fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode });
      created = true;
    }
    if (created) {
      const stat = assertPhysicalObject(rootPath, current, 'new staged directory');
      if (!stat.isDirectory()) throw new Error('New staged path is not a directory');
      assertStagedOwner(stat, 'new staged directory');
      fs.chmodSync(current, mode);
    }
    assertStagedEntry(rootPath, current, 'directory', mode, 'staged directory');
  }
  return assertStagedEntry(rootPath, targetPath, 'directory', mode, 'staged directory');
}

function copyStagedFile(sourceRoot, sourceRelative, outputRoot, outputRelative, expectedSha256) {
  const sourcePath = path.join(sourceRoot, ...sourceRelative.split('/'));
  const sourceStat = assertPhysicalObject(sourceRoot, sourcePath, 'source payload');
  if (!sourceStat.isFile()) throw new Error('Source package payload is not a regular file');
  const outputPath = path.join(outputRoot, ...outputRelative.split('/'));
  ensureStagedDirectory(outputRoot, path.dirname(outputPath), 0o755);
  fs.copyFileSync(sourcePath, outputPath, fs.constants.COPYFILE_EXCL);
  const copiedStat = assertPhysicalObject(outputRoot, outputPath, 'new staged payload');
  if (!copiedStat.isFile()) throw new Error('Copied package payload is not a regular file');
  assertStagedOwner(copiedStat, 'new staged payload');
  fs.chmodSync(outputPath, 0o644);
  assertStagedEntry(outputRoot, outputPath, 'file', 0o644, 'staged payload');
  if (sha256(fs.readFileSync(outputPath)) !== expectedSha256) {
    throw new Error('Copied payload bytes changed while staging: ' + outputRelative);
  }
}

function writeStagedFile(root, relativePath, contents, mode) {
  const outputPath = path.join(root, ...relativePath.split('/'));
  const parentMode = path.dirname(outputPath) === root ? 0o700 : 0o755;
  ensureStagedDirectory(root, path.dirname(outputPath), parentMode);
  fs.writeFileSync(outputPath, contents, { flag: 'wx', mode });
  const stat = assertPhysicalObject(root, outputPath, 'new staged metadata file');
  if (!stat.isFile()) throw new Error('Staged metadata is not a regular file');
  assertStagedOwner(stat, 'staged metadata file');
  fs.chmodSync(outputPath, mode);
  assertStagedEntry(root, outputPath, 'file', mode, 'staged metadata file');
  return outputPath;
}

function verifyStagedTree(root, directoryMode, fileMode) {
  assertStagedEntry(root, root, 'directory', directoryMode, 'staged tree root');
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const fullPath = path.join(directory, name);
      const stat = assertPhysicalObject(root, fullPath, 'staged tree entry');
      if (stat.isDirectory()) {
        assertStagedEntry(root, fullPath, 'directory', directoryMode, 'staged tree directory');
        walk(fullPath);
      } else if (stat.isFile()) {
        assertStagedEntry(root, fullPath, 'file', fileMode, 'staged tree file');
      } else {
        throw new Error('Staged package contains a non-regular entry: ' + path.relative(root, fullPath));
      }
    }
  }
  walk(root);
}

function canonicalFiles(files) {
  return files.slice().sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function stagePrivatePackage({ repositoryRoot = REPOSITORY_ROOT, outDir }) {
  repositoryRoot = path.resolve(repositoryRoot);
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) throw new Error('--out must be an absolute path outside the source repository');
  outDir = path.resolve(outDir);
  const realRepositoryRoot = fs.realpathSync(repositoryRoot);
  const resolvedOutPath = resolveThroughExistingParent(outDir);
  if (isInside(realRepositoryRoot, resolvedOutPath)) throw new Error('Package stage output must be outside the source repository');
  if (!samePath(outDir, resolvedOutPath)) throw new Error('Package stage output must not traverse a symbolic-link path');
  if (fs.existsSync(outDir)) throw new Error('Package stage output already exists; refusing to overwrite it');

  const toolchain = packageToolchain(repositoryRoot);
  const source = verifiedSource(repositoryRoot);
  const ratesFiles = source.ratesFiles;
  const distFiles = source.distFiles;
  const packageSupportFiles = source.packageSupportFiles;
  const stagedPackage = {
    name: toolchain.sourcePackage.name,
    version: toolchain.sourcePackage.version,
    private: true,
    type: 'module',
    main: PACKAGE_MAIN,
    description: 'Local token tracking, reporting, and vendor accountability.',
    author: { name: 'Elo AI' },
    // Internal artifacts grant no public source license; the Apache plan remains counsel-gated.
    license: 'UNLICENSED',
  };
  const stagedPackageBytes = jsonBytes(stagedPackage);
  const appFiles = canonicalFiles([
    ...distFiles.map(file => ({ ...file, path: `dist/${file.path}` })),
    ...ratesFiles.map(file => ({ ...file, path: `rates/${file.path}` })),
    ...packageSupportFiles,
    { path: 'package.json', sizeBytes: stagedPackageBytes.length, sha256: sha256(stagedPackageBytes) },
  ]);

  let createdOutput = false;
  try {
    fs.mkdirSync(outDir, { recursive: false, mode: 0o700 });
    createdOutput = true;
    const outputStat = assertPhysicalObject(outDir, outDir, 'new stage root');
    assertStagedOwner(outputStat, 'new stage root');
    fs.chmodSync(outDir, 0o700);
    assertStagedEntry(outDir, outDir, 'directory', 0o700, 'stage root');
    const appRoot = path.join(outDir, 'app');
    ensureStagedDirectory(outDir, appRoot, 0o755);
    for (const file of distFiles) {
      copyStagedFile(realRepositoryRoot, 'dist/' + file.path, outDir, 'app/dist/' + file.path, file.sha256);
    }
    for (const file of ratesFiles) {
      copyStagedFile(realRepositoryRoot, 'rates/' + file.path, outDir, 'app/rates/' + file.path, file.sha256);
    }
    for (const file of packageSupportFiles) {
      copyStagedFile(realRepositoryRoot, file.path, outDir, 'app/' + file.path, file.sha256);
    }
    writeStagedFile(outDir, 'app/package.json', stagedPackageBytes, 0o644);
    normalizeTimes(appRoot);
    verifyStagedTree(appRoot, 0o755, 0o644);

    const copiedFiles = assertSafeTree(appRoot, 'staged app payload');
    if (JSON.stringify(canonicalFiles(copiedFiles)) !== JSON.stringify(appFiles)) {
      throw new Error('Copied app payload differs from the verified source payload');
    }
    const finalSource = verifiedSource(repositoryRoot);
    const finalRatesFiles = assertAllowedRateFiles(assertSafeTree(path.join(repositoryRoot, 'rates'), 'rates payload'), path.join(repositoryRoot, 'rates'));
    if (finalSource.head !== source.head
      || finalSource.identity.distManifestSha256 !== source.identity.distManifestSha256
      || JSON.stringify(finalRatesFiles) !== JSON.stringify(ratesFiles)
      || JSON.stringify(finalSource.packageSupportFiles) !== JSON.stringify(packageSupportFiles)) {
      throw new Error('Source payload changed while the private package stage was being copied');
    }

    const payloadManifest = { schemaVersion: 1, root: 'app', files: appFiles };
    const payloadManifestBytes = jsonBytes(payloadManifest);
    const payloadManifestSha256 = sha256(payloadManifestBytes);
    const payloadManifestPath = writeStagedFile(outDir, 'payload-manifest.private.json', payloadManifestBytes, 0o600);

    const stageManifest = {
      schemaVersion: 1,
      kind: 'tokenelo-private-electron-stage',
      privacy: 'private',
      releasePolicy: { publish: 'never', publicAutoUpdates: false },
      source: {
        revision: source.head,
        dirty: false,
        distManifestSha256: source.identity.distManifestSha256,
        verificationScope: 'Current clean HEAD and recomputed payload hashes match the build identity written by this checkout; this does not independently attest compiler provenance or reproducible-build equivalence.',
      },
      application: {
        name: stagedPackage.name,
        version: stagedPackage.version,
        private: true,
        type: 'module',
        main: PACKAGE_MAIN,
        electronVersion: toolchain.electronVersion,
        electronBuilderVersion: toolchain.builderVersion,
      },
      payload: {
        fileCount: appFiles.length,
        manifest: 'payload-manifest.private.json',
        manifestSha256: payloadManifestSha256,
        sha256: sha256(JSON.stringify({ schemaVersion: 1, files: appFiles })),
      },
    };
    const stageManifestBytes = jsonBytes(stageManifest);
    const stageManifestPath = writeStagedFile(outDir, 'stage-manifest.private.json', stageManifestBytes, 0o600);

    const sums = [
      ...appFiles.map(file => `${file.sha256}  app/${file.path}`),
      `${payloadManifestSha256}  payload-manifest.private.json`,
      `${sha256(stageManifestBytes)}  stage-manifest.private.json`,
    ].sort();
    const sumsPath = writeStagedFile(outDir, 'SHA256SUMS', sums.join('\n') + '\n', 0o600);
    fs.utimesSync(payloadManifestPath, FIXED_TIME, FIXED_TIME);
    fs.utimesSync(stageManifestPath, FIXED_TIME, FIXED_TIME);
    fs.utimesSync(sumsPath, FIXED_TIME, FIXED_TIME);
    fs.utimesSync(outDir, FIXED_TIME, FIXED_TIME);
    assertStagedEntry(outDir, outDir, 'directory', 0o700, 'stage root');
    assertStagedEntry(outDir, payloadManifestPath, 'file', 0o600, 'payload manifest');
    assertStagedEntry(outDir, stageManifestPath, 'file', 0o600, 'stage manifest');
    assertStagedEntry(outDir, sumsPath, 'file', 0o600, 'checksum manifest');

    return { outDir, stageManifest, payloadManifest };
  } catch (error) {
    if (createdOutput) fs.rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  let outDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) { outDir = argv[++i]; continue; }
    throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!outDir) throw new Error('Usage: node scripts/stage-private-package.mjs --out <absolute-path-outside-repository>');
  return { outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = stagePrivatePackage(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ output: result.outDir, files: result.payloadManifest.files.length, payloadSha256: result.stageManifest.payload.sha256 })}\n`);
  } catch (error) {
    process.stderr.write(`Private package staging refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
