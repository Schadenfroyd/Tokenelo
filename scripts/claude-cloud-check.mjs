import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const pinned = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
if (process.versions.node !== pinned) throw new Error(`Use the pinned Node ${pinned}; found ${process.versions.node}`);
if (process.env.TOKENELO_LIVE === '1') throw new Error('Cloud fixture setup requires TOKENELO_LIVE to be unset');
const stamp = path.join(root, 'node_modules', '.cache', 'tokenelo-cloud-install.json');
const fingerprint = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, 'package.json')))
  .update(fs.readFileSync(path.join(root, 'package-lock.json')))
  .update(`${process.platform}/${process.arch}/${pinned}/ignore-scripts/include-dev/v1`)
  .digest('hex');

function checkDependencies() {
  for (const packageName of ['typescript', 'vitest', 'tsx', 'electron']) require.resolve(`${packageName}/package.json`);
  // --ignore-scripts still installs esbuild's lockfile-selected optional native
  // package. Exercise the native binary, not only its JavaScript entry point.
  const result = require('esbuild').transformSync('const answer: number = 42', { loader: 'ts' });
  if (!result.code.includes('42')) throw new Error('esbuild transform did not complete');
  const db = new DatabaseSync(':memory:');
  try {
    const answer = db.prepare('SELECT 42 AS answer').get().answer;
    if (answer !== 42) throw new Error('SQLite fixture probe failed');
  } finally { db.close(); }
}

let cached = false;
try {
  cached = JSON.parse(fs.readFileSync(stamp, 'utf8')).fingerprint === fingerprint;
  if (cached) checkDependencies();
} catch { cached = false; }
if (process.argv.includes('--setup') && !cached) {
  // Ignore lifecycle scripts completely: no Electron binary download or
  // arbitrary postinstall. Build/test support comes from locked optional deps.
  // Linux distribution installs and official Node archives place npm in
  // different directories. The provisioner puts the selected runtime first on
  // PATH; npm's env-node entry point then uses that same runtime.
  const child = spawnSync('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 180_000,
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Locked dependency installation failed (${child.status})`);
  checkDependencies();
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, JSON.stringify({ version: 1, fingerprint, node: pinned, platform: process.platform, arch: process.arch }) + '\n');
} else checkDependencies();
console.log(JSON.stringify({ ready: true, node: pinned, platform: process.platform, arch: process.arch, cached, electronBinaryInstalledBySetup: false }));
