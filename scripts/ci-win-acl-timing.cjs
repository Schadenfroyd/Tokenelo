'use strict';
// TEMPORARY measurement, never merged. Runs the Windows ACL helper's script exactly as the product runs it (minimal child
// environment, 5 s deadline, stderr ignored) many times as the standard CI user and prints how long each run took, so the
// margin against the 5 s deadline is measured rather than assumed.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function main() {
  const sysRoot = process.env.SystemRoot;
  if (!sysRoot) { console.log('TIMING no SystemRoot; not a Windows environment'); return 1; }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'paths.ts'), 'utf8');
  const open = 'const WINDOWS_ACL_SCRIPT = [';
  const start = src.indexOf(open);
  const end = src.indexOf("].join('\\n');", start);
  if (start < 0 || end < 0) { console.log('TIMING could not extract the ACL script'); return 1; }
  const script = new Function('return [' + src.slice(start + open.length, end) + '].join("\\n")')();
  const psExe = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const minimal = { SystemRoot: sysRoot, windir: sysRoot };
  for (const name of ['TEMP', 'TMP']) { if (process.env[name]) minimal[name] = process.env[name]; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-timing-'));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('TIMING identity: user=' + process.env.USERNAME + ' node=' + process.version + ' script=' + script.split('\n').length + ' lines');

  const runs = 25;
  let counter = 0;
  for (const mode of ['directory', 'file']) {
    const times = [];
    let failures = 0;
    for (let i = 0; i < runs; i++) {
      let target = dataDir;
      if (mode === 'file') { target = path.join(dataDir, 'f' + (counter++)); fs.writeFileSync(target, 'synthetic'); }
      const env = Object.assign({}, minimal, { TOKENELO_ACL_TARGET: target, TOKENELO_ACL_MODE: mode });
      const t0 = process.hrtime.bigint();
      let outcome = 'ok';
      try {
        const out = execFileSync(psExe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000, maxBuffer: 65536, env });
        if (JSON.parse(out.trim()).operation !== mode) outcome = 'wrong operation';
      } catch (error) { outcome = error.code || error.message; }
      const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
      times.push(ms);
      if (outcome !== 'ok') { failures++; console.log('TIMING failure: mode=' + mode + ' run=' + i + ' outcome=' + outcome + ' ms=' + ms); }
    }
    const sorted = times.slice().sort((a, b) => a - b);
    console.log('TIMING ' + mode + ': runs=' + runs + ' failures=' + failures + ' minMs=' + sorted[0] +
      ' medianMs=' + sorted[Math.floor(sorted.length / 2)] + ' p90Ms=' + sorted[Math.floor(sorted.length * 0.9)] +
      ' maxMs=' + sorted[sorted.length - 1] + ' inOrder=' + times.join(','));
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  return 0;
}

process.exit(main());
