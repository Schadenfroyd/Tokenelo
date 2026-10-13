import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = 'f7fa1e89f79bdc3bdd7df9e13195c5c7b5bce6a6';

export function validateRuntime(version) {
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) && Number(version.split('.')[0]) >= 22;
}

export function classifyOrigin(origin) {
  if (!origin.trim()) return 'missing';
  const ssh = origin.match(/^git@github\.com:(.+)$/i);
  if (ssh) return /^Schadenfroyd\/Tokenelo(?:\.git)?$/i.test(ssh[1]) ? 'public' : 'other-github';
  try {
    const url = new URL(origin);
    if (url.hostname === 'github.com' && !url.search && !url.hash) {
      return /^\/Schadenfroyd\/Tokenelo(?:\.git)?\/?$/i.test(url.pathname) ? 'public' : 'other-github';
    }
  } catch { /* Provider proxy origin syntax is not prescribed here. */ }
  return 'opaque';
}

export function validateRoots(roots) {
  const values = roots.trim().split(/\s+/);
  return values.length === 1 && values[0] === publicRoot;
}

export function verify(root) {
  if (!validateRuntime(process.versions.node)) throw new Error('Node.js 22 or newer is required.');
  const run = (command, args, inherit = false) => {
    const result = spawnSync(command, args, {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000,
      stdio: inherit ? 'inherit' : 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    // Never print remote configuration, environment variables, or credential output.
    if (result.error || result.status !== 0) throw new Error(`Verification command failed: ${command === process.execPath ? 'node' : command}`);
    return result.stdout?.trim() ?? '';
  };
  const origin = classifyOrigin(run('git', ['config', '--get', 'remote.origin.url']));
  if (origin === 'other-github' || origin === 'missing') {
    throw new Error('This workflow requires a checkout of the public Tokenelo repository.');
  }
  if (run('git', ['rev-parse', '--is-shallow-repository']) === 'true') {
    // Obtain only the clean public main ancestry, never PR refs or other histories.
    run('git', ['fetch', '--no-tags', '--unshallow', 'https://github.com/Schadenfroyd/Tokenelo.git', 'refs/heads/main']);
  }
  if (!validateRoots(run('git', ['rev-list', '--max-parents=0', 'HEAD']))) {
    throw new Error('Start from current public main; this checkout has unexpected historical roots.');
  }
  if (origin === 'opaque') console.log('Clean public ancestry verified; provider origin transport format is not independently verified.');
  run(process.execPath, ['--test', 'scripts/check-docs.test.mjs', 'scripts/cloud-check.test.mjs'], true);
  run(process.execPath, ['scripts/check-docs.mjs'], true);
  console.log(`Public documentation verification passed on Node ${process.versions.node}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verify(resolve(dirname(fileURLToPath(import.meta.url)), '..')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
