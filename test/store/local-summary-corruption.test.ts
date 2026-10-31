import { describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries } from '../../src/store/queries.js';
import { rowToEvent, type EventRow } from '../../src/store/ledger.js';
import { defaultConfig } from '../../src/daemon/config.js';

// Hand-authored FILED rows, no generation or production data. SQL amounts/counts are the
// independent oracle; unreadable attribution must neither reprice them nor become zero.
const NOW = Date.UTC(2026, 9, 13, 12);
function seed(db: TokeneloDb, id: string, provider = 'local', ts = NOW - 1000) {
  const local = provider === 'local';
  const tokens = { inputFresh: local ? 3 : 7, output: local ? 8 : 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 };
  db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,is_subagent,model,provider,components_json,input_fresh,cache_write_5m,cache_write_1h,cache_read,output,reasoning,flags_json,api_equiv_usd,price_status,price_version,ucu,ucu_rate_status,eacs_def_sha256,duration_ms,thinking)
    VALUES (?, 'OWNED', ?, ?, 'line', ?, 0, ?, ?, ?, ?, 0, 0, 0, ?, 0, '[]', ?, 'LIST', 'OWNED-HISTORICAL-PRICE', 2, 'MEASURED', 'OWNED-HISTORICAL-DEF', 100, NULL)`)
    .run(id, local ? 'ollama-proxy' : 'codex', ts, id, local ? 'OWNED-LOCAL' : 'gpt-6-sol', provider,
      JSON.stringify([{ model: local ? 'OWNED-LOCAL' : 'gpt-6-sol', tokens }]), tokens.inputFresh, tokens.output, local ? 0.11 : 0.15);
}

describe('Summary local read evidence holds unreadable attribution without losing stored totals', () => {
  it.each(['not-json', 'null', '{}', '[null]', '[{"tokens":null}]'])('qualifies malformed component data %s within the recorded range only', async malformed => {
    const db = openDb({ file: ':memory:' });
    try {
      const config = defaultConfig({ hostLabel: 'OWNED' }); config.local.capture = 'off';
      config.local.wattsEstimate = 100; config.local.tariffUsdPerKwh = 0.2;
      seed(db, 'good'); seed(db, 'bad'); seed(db, 'cloud', 'openai');
      seed(db, 'old-bad', 'local', NOW - 3 * 86400_000); seed(db, 'future-bad', 'local', NOW + 1000);
      db.prepare("UPDATE events SET components_json = ? WHERE id LIKE '%bad'").run(malformed);
      const before = db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all();
      const q = createQueries(db, config, { now: () => NOW });
      const summary = await q.getSummary('24h');
      expect(summary.totals).toMatchObject({ events: 3, apiEquivUsd: 0.37, tokens: { inputFresh: 13, output: 17 } });
      expect(summary.byModel.find(m => m.provider === 'local')).toMatchObject({ events: 2, apiEquivUsd: 0.22 });
      expect(summary.local).toMatchObject({ captured: true,
        readEvidence: { version: 1, state: 'malformed-components', captureMode: 'off', events: 2, readableEvents: 1, malformedComponentEvents: 1 },
        valueVsClaude: { usd: null, status: 'NONE' }, valueVsGpt: { usd: null, status: 'NONE' },
        energy: { kwh: null, usd: null, status: 'NONE' }, netSavingsVsClaude: null, netSavingsVsGpt: null });
      expect(summary.local.valueVsClaude.ratedSubtotalUsd).toBeUndefined();
      expect(summary.local.decodeTokPerSec).toBeUndefined();
      expect(summary.local.reason).toMatch(/component evidence/i);
      expect(summary.local.reason).not.toContain(malformed);
      await expect(q.getSessionDetail('ollama-proxy', 'bad')).rejects.toThrow();
      expect(() => rowToEvent(db.prepare("SELECT * FROM events WHERE id='bad'").get() as unknown as EventRow)).toThrow();
      expect(db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(before);
    } finally { db.close(); }
  });
  it('retains the existing complete local result when all rows are readable', async () => {
    const db = openDb({ file: ':memory:' });
    try {
      seed(db, 'good'); const summary = await createQueries(db, defaultConfig({ hostLabel: 'OWNED' }), { now: () => NOW }).getSummary('24h');
      expect(summary.local.readEvidence).toBeUndefined();
      expect(summary.totals.apiEquivUsd).toBe(0.11);
    } finally { db.close(); }
  });
  it('does not swallow an unrelated flags JSON error as a component hold', async () => {
    const db = openDb({ file: ':memory:' });
    try {
      seed(db, 'flags'); db.prepare("UPDATE events SET flags_json='not-json'").run();
      await expect(createQueries(db, defaultConfig({ hostLabel: 'OWNED' }), { now: () => NOW }).getSummary('24h')).rejects.toThrow();
    } finally { db.close(); }
  });
});
