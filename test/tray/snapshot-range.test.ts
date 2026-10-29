import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/tray/api-client.js';
import { parseArgv } from '../../src/tray/argv.js';
import { resolveSnapshotData } from '../../src/tray/snapshot-data.js';
import { initialRange } from '../../src/tray/renderer/initial-scope.js';

const scratchRoot = path.resolve(process.platform === 'win32' ? 'C:\\Temp' : os.tmpdir());
const apiFixturesRoot = path.resolve(__dirname, '../fixtures/api');
const stages: string[] = [];
function fixtures() {
  const root = fs.mkdtempSync(path.join(scratchRoot, 'tokenelo-snapshot-range-'));
  stages.push(root);
  return { root, write: (name: string, data: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(data)) };
}
afterEach(() => {
  for (const stage of stages.splice(0)) {
    expect(path.dirname(path.resolve(stage))).toBe(scratchRoot);
    fs.rmSync(stage, { recursive: true });
  }
});

describe('explicit snapshot range admission', () => {
  it('admits supported scoped tabs after all flags, with the last valid range winning', () => {
    for (const tab of ['sessions','usage','local','fleet']) {
      for (const range of ['today','24h','7d','30d','all']) {
        const scoped=parseArgv(['--snapshot','owned.png','--tab',tab,'--range',range]);
        expect(scoped.range).toBe(range);expect(scoped.rangeError).toBeNull();
        expect(resolveSnapshotData(scoped,{},'owned-fixtures').ok).toBe(true);
      }
      const p=parseArgv(['--snapshot','owned.png','--range','7d','--range','30d','--tab',tab]);
      expect(p.range).toBe('30d');expect(p.rangeRequested).toBe(true);expect(p.rangeError).toBeNull();
      expect(resolveSnapshotData(p,{},'owned-fixtures').ok).toBe(true);
    }
  });
  it('refuses malformed or missing ranges without echoing input or consuming the next flag', () => {
    const missing=parseArgv(['--snapshot','owned.png','--range','--tab','usage']);
    expect(missing.tab).toBe('usage');expect(missing.rangeError).toBe('--range needs the value today, 24h, 7d, 30d or all');
    const bad=parseArgv(['--snapshot','owned.png','--tab','usage','--range','private-path']);
    expect(resolveSnapshotData(bad,{},'owned-fixtures')).toEqual({ok:false,message:'--range needs the value today, 24h, 7d, 30d or all'});
    expect(parseArgv(['--snapshot','owned.png','--tab','usage','--range','all']).range).toBe('all');
  });
  it('refuses explicit ranges on fixed-scope tabs and all-history details', () => {
    for (const tab of ['now','limits','coverage','invalid']) {
      expect(resolveSnapshotData(parseArgv(['--snapshot','owned.png','--tab',tab,'--range','today']),{},'owned-fixtures').ok).toBe(false);
    }
    expect(parseArgv(['--snapshot','owned.png','--tab','usage','--range','30d','--session','claude:record']).rangeError).not.toBeNull();
    expect(initialRange('24h')).toBe('24h');expect(initialRange('all')).toBe('all');expect(initialRange('30d')).toBe('30d');expect(initialRange('7d')).toBe('7d');expect(initialRange('invalid')).toBe('today');expect(initialRange(null)).toBe('today');
  });
});

describe('strict snapshot mock response scope', () => {
  it('serves a frozen FILED-EXAMPLE Today clock and matching range for Sessions and Local', async () => {
    const c = createApiClient({ mockDir: apiFixturesRoot, strictMockRanges: true, fetchImpl: async () => { throw new Error('network must not run'); } });
    const [sessionsResponse, summary] = await Promise.all([c.getSessionsResponse('today'), c.getSummary('today')]);
    const frozenNow = 1790466276688;
    const localSession = sessionsResponse.sessions.find((row) => row.source === 'ollama-proxy');
    const unknownModel = summary.byModel.find((row) => row.model === 'codex-auto-review');
    const claudeSubscription = summary.subscriptions.find((row) => row.kind === 'claude');
    const frozenTodayStart = Date.parse('2026-09-26T06:00:00.000Z');
    const expectedPlanProration = 200 * ((frozenNow - frozenTodayStart) / (86_400_000 * 30));

    expect(sessionsResponse.range).toBe('today');
    expect(summary.range).toBe('today');
    expect(sessionsResponse.generatedAt).toBe(frozenNow);
    expect(summary.generatedAt).toBe(frozenNow);
    expect(sessionsResponse.timeBasis).toEqual({
      startMs: frozenTodayStart,
      asOfMs: frozenNow,
      endInclusive: true,
      timestampBasis: 'recorded-timestamps',
      excludedFutureEvents: 0,
      excludedFutureActivity: 0,
    });
    expect(summary.timeBasis).toEqual(sessionsResponse.timeBasis);
    expect(sessionsResponse.sessions.every((row) => row.start >= sessionsResponse.timeBasis!.startMs! && row.end <= frozenNow)).toBe(true);

    expect(localSession?.apiEquivUsd).toBe(0);
    expect(unknownModel?.apiEquivUsd).toBeNull();
    expect(claudeSubscription?.costBasis).toEqual({
      state: 'configured-proration',
      monthlyUsd: 200,
      rangeStartMs: frozenTodayStart,
      rangeEndMs: frozenNow,
      prorationDays: 30,
      origin: 'configured-plan-price',
      invoiceVerified: false,
    });
    expect(claudeSubscription?.billedUsd).toBeCloseTo(expectedPlanProration, 12);
    expect(claudeSubscription?.apiEquivUsd).toBe(summary.bySource.claude.apiEquivUsd);
    expect(claudeSubscription?.leverage).toBeCloseTo(summary.bySource.claude.apiEquivUsd / expectedPlanProration, 12);
  });

  it('does not borrow a today response for 30d, while preserving the default legacy fallback', async () => {
    const f=fixtures();f.write('summary-today.json',{range:'today',marker:'today-value'});
    const strict=createApiClient({mockDir:f.root,strictMockRanges:true});
    await expect(strict.getSummary('24h')).rejects.toThrow('no mock fixture found');
    await expect(strict.getSummary('30d')).rejects.toThrow('no mock fixture found');
    await expect(strict.getSummaryReport('all')).rejects.toThrow('no mock fixture found');
    expect(await createApiClient({mockDir:f.root}).getSummary('30d')).toEqual({range:'today',marker:'today-value'});
  });
  it('refuses mismatched scope inside an exact-named file, including chart reads', async () => {
    const f=fixtures();for(const name of ['summary-30d.json','timeseries-30d.json'])f.write(name,{range:'today'});
    const c=createApiClient({mockDir:f.root,strictMockRanges:true});
    for(const request of [()=>c.getSummary('30d'),()=>c.getTimeseries('30d')]) {
      await expect(request()).rejects.toThrow(/^mock fixture does not match the requested range$/);
    }
  });
  it('requires an exact scoped session envelope, refusing a legacy array relabel', async () => {
    const f=fixtures();f.write('sessions.json',[]);
    const c=createApiClient({mockDir:f.root,strictMockRanges:true});
    await expect(c.getSessionsResponse('30d')).rejects.toThrow('no mock fixture found');
    f.write('sessions-30d.json',[]);await expect(c.getSessions('30d')).rejects.toThrow('mock fixture does not match the requested range');
    f.write('sessions-30d.json',{range:'30d',generatedAt:1671234567890,sessions:[]});
    expect(await c.getSessionsResponse('30d')).toEqual({range:'30d',generatedAt:1671234567890,sessions:[]});
  });
  it('preserves exact scoped response values without network/token-file access', async () => {
    const f=fixtures();
    f.write('summary-today.json',{range:'today',marker:'calendar-day-value'});
    const c=createApiClient({mockDir:f.root,strictMockRanges:true,tokenFile:path.join(f.root,'absent-token'),fetchImpl:async()=>{throw new Error('network must not run');}});
    for (const range of ['24h','30d','all'] as const) {
      const body={range,generatedAt:1671234567890,marker:`recorded-${range}-value`};
      f.write(`summary-${range}.json`,body);f.write(`timeseries-${range}.json`,body);
      expect(await c.getSummary(range)).toEqual(body);expect(await c.getTimeseries(range)).toEqual(body);
    }
  });
});
