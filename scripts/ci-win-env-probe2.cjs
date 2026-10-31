'use strict';
// TEMPORARY diagnostic, never merged. A bisect showed the Windows ACL helper's script finishes under its minimal environment
// when PSModuleAnalysisCachePath is also set, and hangs without it. This prints that variable's value and the filesystem facts
// around it, then tries candidate values under the minimal environment to find a deterministic, self-contained setting.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function main() {
  const started = Date.now();
  const HANG_MS = 8000;
  const sysRoot = process.env.SystemRoot;
  if (!sysRoot) { console.log('PROBE2 no SystemRoot; not a Windows environment'); return 1; }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'paths.ts'), 'utf8');
  const open = 'const WINDOWS_ACL_SCRIPT = [';
  const start = src.indexOf(open);
  const end = src.indexOf("].join('\\n');", start);
  if (start < 0 || end < 0) { console.log('PROBE2 could not extract the ACL script'); return 1; }
  const script = new Function('return [' + src.slice(start + open.length, end) + '].join("\\n")')();
  const psExe = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const full = Object.assign({}, process.env);
  const base = { SystemRoot: sysRoot, windir: sysRoot };
  for (const name of ['TEMP', 'TMP']) { if (full[name]) base[name] = full[name]; }

  console.log('PROBE2 identity: user=' + process.env.USERNAME + ' node=' + process.version + ' tmp=' + os.tmpdir());
  for (const name of ['PSModuleAnalysisCachePath', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PSModulePath']) {
    console.log('PROBE2 process env ' + name + ' = ' + JSON.stringify(full[name]));
  }
  const cachePath = full.PSModuleAnalysisCachePath;
  if (cachePath) {
    console.log('PROBE2 cache path exists=' + fs.existsSync(cachePath) + ' parent exists=' + fs.existsSync(path.dirname(cachePath)));
    const icacls = spawnSync('icacls', [path.dirname(cachePath)], { encoding: 'utf8', timeout: 20000 });
    console.log('PROBE2 icacls of the cache path parent:\n' + ((icacls.stdout || icacls.stderr || '').trim() || 'no output'));
  }
  for (const hive of [['machine', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']]) {
    const reg = spawnSync('reg', ['query', hive[1], '/v', 'PSModuleAnalysisCachePath'], { encoding: 'utf8', timeout: 20000 });
    console.log('PROBE2 registry ' + hive[0] + ' environment: ' + ((reg.stdout || reg.stderr || '').trim().replace(/\s+/g, ' ') || 'no output'));
  }
  if (full.LOCALAPPDATA) {
    const dir = path.join(full.LOCALAPPDATA, 'Microsoft', 'Windows', 'PowerShell');
    let listing;
    try { listing = fs.readdirSync(dir).join(', '); } catch (e) { listing = 'unreadable: ' + e.code; }
    console.log('PROBE2 default PowerShell data dir ' + dir + ' -> ' + listing);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-probe2-'));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const existingFile = path.join(home, 'psmac-existing');
  fs.writeFileSync(existingFile, '');
  let counter = 0;
  const results = [];

  function trial(label, extra, options) {
    const opts = options || {};
    const target = path.join(dataDir, 'f' + (counter++));
    fs.writeFileSync(target, 'synthetic');
    const env = Object.assign({}, base, extra, { TOKENELO_ACL_TARGET: target, TOKENELO_ACL_MODE: 'file' });
    const t0 = Date.now();
    const r = spawnSync(psExe, args, {
      encoding: 'utf8', windowsHide: true, timeout: HANG_MS, env, maxBuffer: 1 << 20,
      stdio: opts.product ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    });
    const ms = Date.now() - t0;
    let ok = false;
    try {
      const j = JSON.parse((r.stdout || '').trim());
      ok = r.status === 0 && j.aceCount === 1 && j.parentOwnerSid === j.currentSid && j.fileOwnerSid === j.currentSid;
    } catch { ok = false; }
    const failure = ok ? '' : ' stderr=' + JSON.stringify((r.stderr || '').trim().slice(0, 300));
    console.log('PROBE2 ' + label + ': ok=' + ok + ' ms=' + ms + ' status=' + r.status + ' error=' + (r.error ? (r.error.code || r.error.message) : 'none') + failure);
    results.push([label, ok]);
    return ok;
  }

  const fresh = path.join(os.tmpdir(), 'tokenelo-psmac-' + process.pid, 'ModuleAnalysisCache');
  const unwritable = path.join(sysRoot, 'System32', 'tokenelo-no-such-dir', 'ModuleAnalysisCache');
  const profileGroup = {};
  for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH']) { if (full[name]) profileGroup[name] = full[name]; }
  const candidates = [
    ['baseline: minimal environment', {}],
    ['parent value of PSModuleAnalysisCachePath', cachePath ? { PSModuleAnalysisCachePath: cachePath } : null],
    ['PSModuleAnalysisCachePath = nul', { PSModuleAnalysisCachePath: 'nul' }],
    ['PSModuleAnalysisCachePath = NUL (upper case)', { PSModuleAnalysisCachePath: 'NUL' }],
    ['PSModuleAnalysisCachePath = a path in a directory that does not exist yet', { PSModuleAnalysisCachePath: fresh }],
    ['PSModuleAnalysisCachePath = an existing empty file', { PSModuleAnalysisCachePath: existingFile }],
    ['PSModuleAnalysisCachePath = empty string', { PSModuleAnalysisCachePath: '' }],
    ['PSModuleAnalysisCachePath = a path this user cannot create', { PSModuleAnalysisCachePath: unwritable }],
    ['LOCALAPPDATA only', full.LOCALAPPDATA ? { LOCALAPPDATA: full.LOCALAPPDATA } : null],
    ['profile variables (USERPROFILE, LOCALAPPDATA, APPDATA, HOMEDRIVE, HOMEPATH)', Object.keys(profileGroup).length ? profileGroup : null],
  ];
  for (const [label, extra] of candidates) {
    if (!extra) { console.log('PROBE2 skipped (variable not present): ' + label); continue; }
    trial(label, extra);
  }
  // Repeat each candidate that worked, as the product calls it (5 s, stderr ignored), to check it is stable.
  for (const [label, extra] of candidates) {
    const first = results.find((entry) => entry[0] === label);
    if (!extra || !first || !first[1] || label.startsWith('baseline')) continue;
    for (let i = 1; i <= 2; i++) trial('repeat ' + i + ' as the product calls it: ' + label, extra, { product: true });
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('PROBE2 finished after ' + Math.round((Date.now() - started) / 1000) + ' s; this job fails by design so the result is reported');
  return 1;
}

process.exit(main());
