'use strict';
// TEMPORARY diagnostic, never merged. The Windows ACL helper in src/daemon/paths.ts runs a fixed PowerShell script with a
// minimal child environment. As a standard user that script does not finish; with the full environment it does. This finds the
// smallest set of environment variables, taken from this process's own environment, that makes it finish. Only variable
// names are printed, never values.

/**
 * Shrinks `keys` to a subset that `works` still accepts and from which no single key can be removed (1-minimal).
 * Tries large chunks first so a handful of required keys costs few trials.
 */
function reduce(keys, works) {
  let set = keys.slice();
  let chunk = Math.max(1, Math.floor(set.length / 2));
  for (;;) {
    let progressed = false;
    let i = 0;
    while (i < set.length) {
      const candidate = set.slice(0, i).concat(set.slice(i + chunk));
      if (candidate.length < set.length && works(candidate)) {
        set = candidate;
        progressed = true;
      } else {
        i += chunk;
      }
    }
    if (chunk === 1) {
      if (!progressed) return set;
    } else {
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
}

function main() {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const started = Date.now();
  const BUDGET_MS = 9 * 60 * 1000;
  const HANG_MS = 8000;
  const sysRoot = process.env.SystemRoot;
  if (!sysRoot) { console.log('BISECT no SystemRoot; not a Windows environment'); return 1; }

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'paths.ts'), 'utf8');
  const open = 'const WINDOWS_ACL_SCRIPT = [';
  const start = src.indexOf(open);
  const end = src.indexOf("].join('\\n');", start);
  if (start < 0 || end < 0) { console.log('BISECT could not extract the ACL script'); return 1; }
  const script = new Function('return [' + src.slice(start + open.length, end) + '].join("\\n")')();
  console.log('BISECT extracted the ACL script: ' + script.split('\n').length + ' lines');

  const psExe = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

  const full = Object.assign({}, process.env);
  const base = { SystemRoot: sysRoot, windir: sysRoot };
  for (const name of ['TEMP', 'TMP']) { if (full[name]) base[name] = full[name]; }
  const baseNames = new Set(Object.keys(base).map((name) => name.toLowerCase()));
  const candidates = Object.keys(full).filter((name) =>
    !name.startsWith('=') && !/^TOKENELO_ACL_/i.test(name) && !baseNames.has(name.toLowerCase()));
  console.log('BISECT identity: user=' + process.env.USERNAME + ' node=' + process.version + ' candidateVariables=' + candidates.length);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-bisect-'));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let counter = 0;

  function trial(label, extra, options) {
    if (Date.now() - started > BUDGET_MS) throw new Error('time budget used');
    const opts = options || {};
    const target = path.join(dataDir, 'f' + (counter++));
    fs.writeFileSync(target, 'synthetic');
    const env = Object.assign({}, base);
    for (const name of extra) env[name] = full[name];
    env.TOKENELO_ACL_TARGET = target;
    env.TOKENELO_ACL_MODE = 'file';
    const t0 = Date.now();
    const r = spawnSync(psExe, args, {
      encoding: 'utf8', windowsHide: true, timeout: opts.timeout || HANG_MS, env, maxBuffer: 1 << 20,
      stdio: opts.product ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    });
    const ms = Date.now() - t0;
    let ok = false;
    try {
      const j = JSON.parse((r.stdout || '').trim());
      ok = r.status === 0 && j.aceCount === 1 && j.parentOwnerSid === j.currentSid && j.fileOwnerSid === j.currentSid;
    } catch { ok = false; }
    console.log('BISECT ' + label + ': ok=' + ok + ' ms=' + ms + ' status=' + r.status +
      ' error=' + (r.error ? (r.error.code || r.error.message) : 'none') + ' extraVariables=' + extra.length);
    return ok;
  }

  try {
    const minimalOk = trial('minimal environment', []);
    const fullOk = trial('full environment', candidates, { timeout: 30000 });
    console.log('BISECT baseline: minimal ok=' + minimalOk + ', full ok=' + fullOk);
    if (!fullOk) console.log('BISECT the full environment does not work either; nothing to bisect');
    else if (minimalOk) console.log('BISECT the minimal environment works here; no reproduction');
    else {
      const forward = reduce(candidates, (set) => trial('reduce', set));
      console.log('BISECT RESULT forward order, smallest sufficient set: ' + JSON.stringify(forward));
      const backward = reduce(candidates.slice().reverse(), (set) => trial('reduce-reverse', set));
      console.log('BISECT RESULT reverse order, smallest sufficient set: ' + JSON.stringify(backward));
      for (const [label, set] of [['forward', forward], ['reverse', backward]]) {
        for (let i = 1; i <= 3; i++) trial('verify ' + label + ' set, run ' + i + ', as the product calls it (5 s, stderr ignored)', set, { product: true, timeout: 5000 });
      }
      for (const name of forward) trial('forward set without ' + name, forward.filter((other) => other !== name));
    }
  } catch (error) {
    console.log('BISECT stopped: ' + error.message);
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('BISECT finished after ' + Math.round((Date.now() - started) / 1000) + ' s; this job fails by design so the result is reported');
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { reduce };
