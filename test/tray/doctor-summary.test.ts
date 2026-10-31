import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/tray/renderer/api-types.js';
import { doctorBuildIdentityBadge, doctorSummary } from '../../src/tray/renderer/doctor-summary.js';

const report = (input: object): DoctorReport => input as DoctorReport;
const values = (input: object) => doctorSummary(report(input)).map((row) => row.value);

describe('whole-history Doctor evidence', () => {
  it('keeps unknown evidence separate from a recorded zero', () => {
    expect(values({ warnings: [] })).toEqual([...Array(6).fill('Evidence unavailable'), 'Price field checks unavailable', ...Array(6).fill('Evidence unavailable')]);
    expect(values({ skippedPaths: [], codex: { suspectFiles: 0 }, unmatchedModels: [], ollama: { capture: 'off', unmeteredRequests: 0 } }))
      .toEqual(['0 paths reported', '0 files flagged', '0 events', 'Off', '0 requests reported', 'Evidence unavailable', 'Price field checks unavailable', '0 paths reported', '0 holds recorded', 'Evidence unavailable', 'Evidence unavailable', '0 models', 'Evidence unavailable']);
  });

  it('distinguishes unreadable paths from intentional skip reasons and events', () => {
    const input = { skippedPaths: [{ reason: 'unreadable', count: 90 }, { reason: 'memory-vault', count: 14 }, { reason: 'not-whitelisted', count: 4 }, { reason: 'timestamp-unavailable', count: 3 }], codex: { suspectFiles: 50 }, unmatchedModels: [{ events: 50057 }, { events: 21642 }, { events: 176 }, { events: 25 }], ollama: { capture: 'off', unmeteredRequests: 7 } };
    expect(values(input)).toEqual(['90 paths reported', '50 files flagged', '71,900 events', 'Off', '7 requests reported', 'Evidence unavailable', 'Price field checks unavailable', '3 paths reported', '0 holds recorded', ...Array(4).fill('Evidence unavailable')]);
  });

  it.each([-1, NaN, Infinity, 1.5])('rejects invalid reported counts (%s)', (bad) => {
    expect(values({ skippedPaths: [{ reason: 'unreadable', count: bad }, { reason: 'timestamp-unavailable', count: bad }, { reason: 'checkpoint-unverified', count: bad }], codex: { suspectFiles: bad }, unmatchedModels: [{ events: bad }], ollama: { unmeteredRequests: bad } }))
      .toEqual([...Array(6).fill('Evidence unavailable'), 'Price field checks unavailable', ...Array(6).fill('Evidence unavailable')]);
  });

  it('shows aggregate Codex count-quality signals without presenting them as usage totals', () => {
    const row = doctorSummary(report({ codex: {
      resetFiles: 2, inheritedBaselineFiles: 8, suspectFiles: 3, recordReconciledFiles: 5,
      nonZeroCacheWrite: 4, ownInWrapperFiles: 1, ownInWrapperEvents: 6, trailingRecordFiles: 7,
    } })).find((entry) => entry.label === 'Codex baseline review')!;
    expect(row.value).toBe('3 files flagged');
    expect(row.note).toContain('inherited/replay files: 8');
    expect(row.note).toContain('counter-reset files: 2');
    expect(row.note).toContain('record-derived token_count files: 5');
    expect(row.note).toContain('non-zero cache-write events: 4');
    expect(row.note).toContain('own-in-wrapper files: 1');
    expect(row.note).toContain('own-in-wrapper events: 6');
    expect(row.note).toContain('trailing-record files: 7');
    expect(row.note).toContain('file/event counts may overlap; not usage totals');
    expect(row.note).toContain('Raw cumulative thread counters are diagnostic only');
  });

  it('keeps unavailable auxiliary Codex quality signals unknown on older reports', () => {
    const row = doctorSummary(report({ codex: { suspectFiles: 0 } })).find((entry) => entry.label === 'Codex baseline review')!;
    expect(row.value).toBe('0 files flagged');
    expect(row.note).toContain('Additional Codex count-quality evidence is unavailable; absence does not mean zero.');
  });

  it('rejects an unsafe sum instead of reporting a rounded count', () => {
    expect(values({ unmatchedModels: [{ events: Number.MAX_SAFE_INTEGER }, { events: 1 }] })[2]).toBe('Evidence unavailable');
  });

  it('shows requested unmatched model IDs without exposing hostnames, paths or warning text', () => {
    const rows = doctorSummary(report({ host: 'private-host', skippedPaths: [{ reason: 'unreadable', count: 1, examples: ['C:/private/account'] }, { reason: 'timestamp-unavailable', count: 1, examples: ['C:/private/timing'] }], unmatchedModels: [{ model: 'private-model', events: 2 }], warnings: ['private-warning'] }));
    expect(JSON.stringify(rows)).toContain('private-model');
    expect(JSON.stringify(rows)).not.toContain('private-host');
    expect(JSON.stringify(rows)).not.toContain('C:/private/account');
    expect(JSON.stringify(rows)).not.toContain('C:/private/timing');
    expect(JSON.stringify(rows)).not.toContain('private-warning');
    expect(rows.every((row) => row.note.length > 0)).toBe(true);
  });

  it.each([['proxy', 'Proxy configured'], ['serverlog', 'Server log configured'], ['future-mode', 'Evidence unavailable']])('qualifies capture mode %s without assuming it succeeded', (mode, label) => {
    const rows = doctorSummary(report({ ollama: { capture: mode } }));
    expect(rows[3]?.value).toBe(label);
    expect(rows[3]?.note).toContain('does not establish successful or complete capture');
  });

  it.each([
    ['matching', 'Build: Match', 'same clean source and distribution identity'],
    ['matching-dirty', 'Build: Dirty', 'source is marked dirty'],
    ['mismatch', 'Build: Mismatch', 'different package identities'],
    ['unknown', 'Build: Unknown', 'Unknown is not a match or mismatch'],
  ] as const)('labels runtime identity %s without exposing revision or hash values', (state, text, note) => {
    const badge = doctorBuildIdentityBadge(report({ runtimeBuildIdentity: { state, observedAt: 1_700_000_000_000 } }));
    expect(badge.text).toBe(text);
    expect(badge.state).toBe(state);
    expect(badge.note).toContain(note);
    expect(badge.note).toContain('Authenticated health read: 2023-11-14T22:13:20.000Z.');
    expect(JSON.stringify(badge)).not.toContain('sourceRevision');
    expect(JSON.stringify(badge)).not.toContain('distManifestSha256');
  });
});


it('preserves unavailable fields separately from explicit zero and empty observations', () => {
  const missing = doctorSummary(report({ ollama: { capture: 'off' } }));
  const missingValue = (label: string) => missing.find((row) => row.label === label)?.value;
  expect(missingValue('Claude speed-assumed events')).toBe('Evidence unavailable');
  expect(missingValue('Claude cache-split-assumed events')).toBe('Evidence unavailable');
  expect(missingValue('Unmatched model IDs')).toBe('Evidence unavailable');
  expect(missingValue('Ollama server/log identity')).toBe('Evidence unavailable');

  const zero = doctorSummary(report({
    claude: { speedAssumed: 0, cacheSplitAssumed: 0 },
    unmatchedModels: [],
    ollama: { capture: 'off', servers: [] },
  }));
  const zeroValue = (label: string) => zero.find((row) => row.label === label)?.value;
  expect(zeroValue('Claude speed-assumed events')).toBe('0 events');
  expect(zeroValue('Claude cache-split-assumed events')).toBe('0 events');
  expect(zeroValue('Unmatched model IDs')).toBe('0 models');
  expect(zeroValue('Ollama server/log identity')).toBe('0 server rows');
  expect(zero.find((row) => row.label === 'Ollama server/log identity')?.note).toContain('does not prove no process is listening');
});

it('bounds unmatched model and server details while retaining log availability and report time', () => {
  const unmatchedModels = Array.from({ length: 7 }, (_, i) => ({ model: `model-${i}`, events: i + 1 }));
  const servers = [
    { address: '127.0.0.1', family: 'IPv4', version: '0.32.13', binary: '/opt/homebrew/opt/ollama/bin/ollama', logPath: '/opt/homebrew/var/log/ollama.log', logAvailable: true },
    { address: '::1', family: 'IPv6', version: '0.34.2', binary: '/Applications/Ollama.app/Contents/Resources/ollama', logPath: '/Users/private/.ollama/logs/server.log', logAvailable: false },
    ...Array.from({ length: 5 }, (_, i) => ({ address: `127.0.0.${i + 2}`, family: 'IPv4', version: '0.34.2', logPath: '/tmp/ollama.log', logAvailable: false })),
  ];
  const rows = doctorSummary(report({
    generatedAt: 1_760_000_000_000,
    unmatchedModels,
    ollama: { capture: 'both', servers },
  }));
  const modelRow = rows.find((row) => row.label === 'Unmatched model IDs')!;
  expect(modelRow.value).toBe('7 models');
  expect(modelRow.note).toContain('model-0 · 1 event');
  expect(modelRow.note).toContain('model-4 · 5 events');
  expect(modelRow.note).toContain('2 additional model IDs omitted');
  expect(modelRow.note).not.toContain('model-5 ·');

  const serverRow = rows.find((row) => row.label === 'Ollama server/log identity')!;
  expect(serverRow.value).toBe('7 server rows');
  expect(serverRow.note).toContain('Doctor report generated');
  expect(serverRow.note).toContain('127.0.0.1 (IPv4) · Ollama 0.32.13 · process ollama · log ollama.log (available)');
  expect(serverRow.note).toContain('::1 (IPv6) · Ollama 0.34.2 · process ollama · log server.log (unavailable)');
  expect(serverRow.note).toContain('3 additional server rows omitted');
  expect(serverRow.note).not.toContain('/opt/homebrew');
  expect(serverRow.note).not.toContain('/Users/private');
});

it('checkpoint history reports recorded attempts, never current missing tokens or private paths',()=>{
  const row=doctorSummary(report({skippedPaths:[{reason:'checkpoint-unverified',count:4,examples:['private/path']},{reason:'checkpoint-unverified',count:2}]})).find(r=>r.label==='Checkpoint hold history')!;
  expect(row.value).toBe('6 holds recorded');expect(row.note).toContain('does not show current pending capture or missing tokens');expect(JSON.stringify(row)).not.toContain('private/path');
});


it('current backlog is disclosed separately from historical totals and zero is not complete capture',()=>{
  const backlog={observedAt:123,pending:2,quarantined:0,writeFailures:0,bytes:400,oldestQueuedAt:100,lastError:'ledger-busy'};
  const row=doctorSummary(report({ollama:{capture:'proxy',backlog}})).find(r=>r.label==='Proxy capture backlog')!;
  expect(row.value).toBe('2 requests waiting');expect(row.note).toContain('excluded from recorded totals');
  const empty=doctorSummary(report({ollama:{capture:'proxy',backlog:{...backlog,pending:0}}})).find(r=>r.label==='Proxy capture backlog')!;
  expect(empty.value).toBe('0 requests waiting');expect(empty.note).toContain('zero does not prove complete capture');
});
it('local save failures or quarantined observations disclose capture uncertainty without paths or contents',()=>{
  const row=doctorSummary(report({ollama:{backlog:{pending:0,quarantined:1,writeFailures:2}}})).find(r=>r.label==='Proxy capture backlog')!;
  expect(row.note).toContain('Capture needs review');expect(row.note).toContain('usage history may be incomplete');
});


it('backlog copy never claims a rejected observation was retained and discloses its separate clock',()=>{
  const row=doctorSummary(report({ollama:{backlog:{observedAt:1000,pending:1,quarantined:0,writeFailures:1}}})).find(r=>r.label==='Proxy capture backlog')!;
  expect(row.note).toContain('Observed ');expect(row.note).toContain('could not be saved');expect(row.note).not.toContain('save failures are retained');
  const unknown=doctorSummary(report({ollama:{backlog:{observedAt:Number.MAX_SAFE_INTEGER,pending:0,quarantined:0,writeFailures:0}}})).find(r=>r.label==='Proxy capture backlog')!;
  expect(unknown.note).toContain('Queue observation time unavailable');expect(unknown.note).toContain('zero does not prove complete capture');
});

it('Doctor discloses when current failure evidence could not be stored without inventing persistence for older runtimes',()=>{
  const row=doctorSummary(report({ollama:{backlog:{observedAt:1000,pending:0,quarantined:0,writeFailures:1,failureEvidenceStored:false}}})).find(r=>r.label==='Proxy capture backlog')!;
  expect(row.note).toContain('Failure evidence could not be stored');expect(row.note).toContain('may not survive restart');
  const older=doctorSummary(report({ollama:{backlog:{observedAt:1000,pending:0,quarantined:0,writeFailures:1}}})).find(r=>r.label==='Proxy capture backlog')!;expect(older.note).not.toContain('evidence could not be stored');
});

it('reports each configured local capture mode without treating both as unknown', () => {
  const value = (capture: unknown) => doctorSummary(report({ ollama: { capture } })).find((row) => row.label === 'Local server capture')!.value;
  expect(value('off')).toBe('Off');
  expect(value('proxy')).toBe('Proxy configured');
  expect(value('serverlog')).toBe('Server log configured');
  expect(value('both')).toBe('Proxy and server log configured');
  expect(value(undefined)).toBe('Evidence unavailable');
  expect(value('unexpected')).toBe('Evidence unavailable');
});
