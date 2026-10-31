import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexCollector } from '../../src/collectors/codex.js';
import * as prefixEvidence from '../../src/collectors/codex-prefix.js';
import { baseTestConfig, makeHarness } from '../claude/helpers.js';
import { makeEvent } from '../store/stubs.js';
import { Rollout } from './helpers.js';

const SID = '01a0819d-cfe2-7ef0-8f65-12c21ee505e1';
const SID2 = '01a0819d-cfe2-7ef0-8f65-12c21ee505e2';
const TURN = '01a0819d-d01b-75c1-993c-c0c752866014';
const RECEIPT = 'tokenelo/codex-context-checkpoint@v1:';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-context-collector-'));
  const h = makeHarness({ ...baseTestConfig(), codex: { homes: [root] } });
  fs.mkdirSync(path.join(root, 'sessions'));
  const file = (sid = SID) => path.join(root, 'sessions', `rollout-2026-09-08T15-23-05-${sid}.jsonl`);
  const scan = () => new CodexCollector({ homes: [root], now: () => Date.now() + 2 * 3600000 }).scan(h.ctx);
  const rows = () => h.db.prepare('SELECT rowid,* FROM ingest_state ORDER BY key').all();
  const receipts = () => h.db.prepare('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key').all(RECEIPT + '%') as Array<{ key: string; value: string }>;
  const replace = (sid = SID) => {
    const r = new Rollout().meta({ id: sid, cwd: '/context/replacement' }).tokenCount([800, 200, 80], [0, 0, 0]);
    const temp = file(sid) + '.replacement';
    fs.writeFileSync(temp, r.text());fs.unlinkSync(file(sid));fs.renameSync(temp, file(sid));
    return r;
  };
  const close = () => {
    h.close();
    // Only this test's unique fixture directory is removed, never a shared temp root.
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('fixture escaped owned temp directory');
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ...h, root, file, scan, rows, receipts, replace, close };
}

it('batches replaced context proofs once, preserves typed originals, and counts a later own append exactly once', async () => {
  const h = fixture();
  try {
    for (const id of [SID, SID2]) fs.writeFileSync(h.file(id), new Rollout().meta({ id }).tokenCount([500, 100, 50], [0, 0, 0]).text());
    await h.scan();
    const before = h.rows();
    const accountingBefore = h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all();
    const r = h.replace();h.replace(SID2);
    const batch = vi.spyOn(h.ledger, 'recoverCodexContextCheckpoints');
    const result = await h.scan();
    expect(result.filesSkipped).toBe(0);expect(result.eventsEmitted).toBe(0);
    expect(batch).toHaveBeenCalledTimes(1);expect(batch.mock.calls[0]![0]).toHaveLength(2);
    expect(h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(accountingBefore);
    expect(h.receipts()).toHaveLength(2);
    for (const old of before) {
      const current = h.db.prepare('SELECT rowid,* FROM ingest_state WHERE key=?').get(old.key)!;
      expect(current.rowid).toBe(old.rowid);
      const extra = JSON.parse(String(current.extra_json)) as { contextCheckpointReceiptId: string };
      const receipt = h.receipts().find(x => x.key === extra.contextCheckpointReceiptId)!;
      const payload = JSON.parse(receipt.value) as { priorExtraJson: string };
      expect(payload.priorExtraJson).toBe(old.extra_json);
    }
    await h.scan();expect(h.receipts()).toHaveLength(2);expect(batch).toHaveBeenCalledTimes(1);

    const start = r.lines.length;
    r.taskStarted(TURN, 1788264000).turnContextNested(TURN, 'gpt-6-sol', 'low').assistant()
      .record(SID, TURN, 'after-context', [100, 0, 10]).tokenCount([900, 200, 90], [100, 0, 10]);
    fs.appendFileSync(h.file(), r.lines.slice(start).join('\n') + '\n');
    await h.scan();
    expect(h.ledger.getEvents({}).reduce((n, e) => n + e.tokens.inputFresh + e.tokens.cacheRead + e.tokens.output, 0)).toBe(110);
    const accounted = h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all();
    await h.scan();expect(h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(accounted);
    expect(h.receipts()).toHaveLength(2);
  } finally { vi.restoreAllMocks();h.close(); }
});

it('holds a queued context when an accounting owner appears before the guarded batch', async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.file(), new Rollout().meta({ id: SID }).text());await h.scan();
    const before = h.rows();h.replace();
    const batch = h.ledger.recoverCodexContextCheckpoints.bind(h.ledger);
    vi.spyOn(h.ledger, 'recoverCodexContextCheckpoints').mockImplementation(candidates => {
      h.ledger.upsertEvents([makeEvent({ id: `codex:${SID}:owner`, source: 'codex', sessionId: SID, inputFresh: 1, output: 1 })]);
      return batch(candidates);
    });
    const result = await h.scan();
    expect(result.filesSkipped).toBe(1);expect(h.rows()).toEqual(before);expect(h.receipts()).toHaveLength(0);
    expect(h.db.prepare('SELECT count(*) n FROM events').get()).toEqual({ n: 1 });
  } finally { vi.restoreAllMocks();h.close(); }
});

it.each(['wrong-length','sparse','wrong-type'] as const)('rolls back receipt and cursor writes for %s recovery outcomes', async mode => {
  const h = fixture();
  try {
    fs.writeFileSync(h.file(), new Rollout().meta({ id: SID }).text());await h.scan();
    const before = h.rows();h.replace();
    const batch = h.ledger.recoverCodexContextCheckpoints.bind(h.ledger);
    vi.spyOn(h.ledger, 'recoverCodexContextCheckpoints').mockImplementation(candidates => {
      batch(candidates);
      return mode==='sparse' ? new Array<boolean>(candidates.length)
        : mode==='wrong-type' ? [undefined as unknown as boolean] : [];
    });
    const result = await h.scan();
    expect(result.filesSkipped).toBe(1);expect(h.rows()).toEqual(before);expect(h.receipts()).toHaveLength(0);
    expect(h.db.prepare('SELECT count(*) n FROM events').get()).toEqual({ n: 0 });
  } finally { vi.restoreAllMocks();h.close(); }
});

it('holds a same-object, same-size, restored-mtime rewrite between parsing and witness hashing', async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.file(), new Rollout().meta({ id: SID }).text());await h.scan();
    const before = h.rows();h.replace();
    const fixed = new Date(Date.UTC(2026, 8, 8, 16));fs.utimesSync(h.file(), fixed, fixed);
    const original = prefixEvidence.codexPrefixWitness;
    let rewritten = false;
    vi.spyOn(prefixEvidence, 'codexPrefixWitness').mockImplementation(async (...args) => {
      if (args[0] === h.file() && args[2] === undefined && args[3] === false) {
        const raw = fs.readFileSync(h.file(), 'utf8');
        const changed = raw.replace('"input_tokens":800', '"input_tokens":900').replace('"total_tokens":880', '"total_tokens":980');
        expect(changed).not.toBe(raw);expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(raw));
        fs.writeFileSync(h.file(), changed);fs.utimesSync(h.file(), fixed, fixed);rewritten = true;
      }
      return original(...args);
    });
    const result = await h.scan();
    expect(rewritten).toBe(true);expect(result.filesSkipped).toBe(1);
    expect(h.rows()).toEqual(before);expect(h.receipts()).toHaveLength(0);
    expect(h.db.prepare('SELECT count(*) n FROM events').get()).toEqual({ n: 0 });
  } finally { vi.restoreAllMocks();h.close(); }
});
