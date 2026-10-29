import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cloud-pure-report-'));
const resultFile = path.join(scratch, 'result.json');
const portableNames = [
  'rejects unowned service names', 'passes literal dollars',
  'env assignment-looking executable', 'retained cgroup kill ENODEV',
  'late outer close after quarantine', 'oversized native frame clears',
  'keeps a valid retirement receipt', 'refuses oversized start data',
  'contradictory native startup frame', 'invalid native receipt order',
];
const testNamePattern = portableNames.join('|');
const files = ['test/daemon/report-linux-unit.test.ts', 'test/daemon/report-process-framing.test.ts'];
const startedAt = new Date().toISOString();
const child = spawnSync(process.execPath, [
  path.join(repo, 'node_modules/vitest/vitest.mjs'), 'run', ...files,
  '-t', testNamePattern, '--reporter=json', `--outputFile=${resultFile}`,
], {
  cwd: repo, env: { ...process.env, TOKENELO_LIVE: '0' },
  encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 ** 2,
});
let result;
try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); }
catch { /* A missing or malformed result remains a failed diagnostic. */ }
const cases = result?.testResults?.flatMap(file => file.assertionResults ?? []) ?? [];
const passed = cases.filter(test => test.status === 'passed');
const filtered = cases.filter(test => test.status === 'skipped' || test.status === 'pending');
const failed = cases.filter(test => test.status === 'failed');
// The original fourteen selected checks and eleven filtered cases stay intact.
// The additive bootstrap privacy regression runs in the original full suite;
// this separately scoped diagnostic must identify it explicitly as filtered.
const additiveFilteredName = 'clears inherited Electron mode and passes only the exact Node-run sentinel without leaking private values';
const additiveFiltered = filtered.filter(test => test.fullName.includes(additiveFilteredName));
const valid = !child.error && child.status === 0 && result?.success === true
  && cases.length === 26 && passed.length === 14 && filtered.length === 12 && failed.length === 0
  && additiveFiltered.length === 1
  && passed.every(test => portableNames.some(name => test.fullName.includes(name)));
const receipt = {
  version: 1, scope: 'Existing pure report checks; separately filtered diagnostic, not full alpha acceptance',
  startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  files, testNamePattern, passed: passed.length, failed: failed.length,
  explicitlyFiltered: filtered.length, totalTwoFileCases: cases.length,
  originalSelectedChecks: 14, originalFilteredCases: 11,
  additiveFilteredCases: additiveFiltered.length, additiveFilteredName,
  additiveCaseInDefaultFullSuite: true,
  originalDefaultSuiteChanged: false, originalPerCaseAndTwoWorkerSettingsChanged: false,
  success: valid,
  ...(valid ? {} : { retainedOwnedFailureOutput: scratch, exitCode: child.status, errorCode: child.error?.code ?? null }),
};
console.log(JSON.stringify(receipt));
if (valid) fs.rmSync(scratch, { recursive: true, force: true });
else {
  fs.writeFileSync(path.join(scratch, 'stdout.log'), child.stdout ?? '');
  fs.writeFileSync(path.join(scratch, 'stderr.log'), child.stderr ?? '');
  fs.writeFileSync(path.join(scratch, 'receipt.json'), JSON.stringify(receipt, null, 2));
  process.exitCode = 1;
}
