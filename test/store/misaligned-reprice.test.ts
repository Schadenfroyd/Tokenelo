import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { mergeDuplicateEvent, rowToEvent, SqliteLedger, type EventRow } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { makeEvent } from './stubs.js';

// P2-1 (2026-10-04): a row merged from two lines whose components do not line up keeps its proven field-wise MAX tokens. A later reprice or an
// identical re-ingest must not replace them with the sum of the kept components. Runs through the real SqliteLedger upsert path.

function misalignedRow() {
  // Two duplicate lines of one event: different models, so the components cannot be aligned. Tokens are the field-wise MAX.
  const stored = makeEvent({ id: 'msg-misaligned', model: 'gpt-5.6-sol', inputFresh: 100, output: 10, thinking: null });
  const incoming = makeEvent({ id: 'msg-misaligned', model: 'claude-sonnet-5', inputFresh: 50, output: 20, thinking: null });
  return mergeDuplicateEvent(stored, incoming);
}

describe('a misaligned-merge row keeps its MAX tokens through reprice and re-ingest (P2-1)', () => {
  it('the merge itself flags the row and keeps field-wise MAX tokens', () => {
    const m = misalignedRow();
    expect(m.flags).toContain('mergedComponentsMisaligned');
    expect(m.tokens.inputFresh).toBe(100);
    expect(m.tokens.output).toBe(20);
  });

  it('reprice (export, then upsert) leaves tokens, components and the flag unchanged', () => {
    const db = openDb({ file: ':memory:' });
    const ledger = new SqliteLedger(db, defaultPricingEngine(), createNullEngine());
    ledger.upsertEvents([misalignedRow()]);
    const before = db.prepare('SELECT input_fresh, output, components_json, flags_json FROM events WHERE id = ?').get('msg-misaligned') as unknown as EventRow & Record<string, unknown>;

    // exactly what `tokenelo reprice` does: export every event and feed it back through the upsert
    const exported = db.prepare('SELECT * FROM events ORDER BY rowid').all().map((r) => rowToEvent(r as unknown as EventRow));
    ledger.upsertEvents(exported, { reprice: true });

    const after = db.prepare('SELECT input_fresh, output, components_json, flags_json FROM events WHERE id = ?').get('msg-misaligned') as unknown as Record<string, unknown>;
    expect(after.input_fresh).toBe(before.input_fresh);
    expect(after.output).toBe(before.output);
    expect(after.components_json).toBe(before.components_json);
    expect(after.flags_json).toBe(before.flags_json);
    expect(after.input_fresh).toBe(100); // the proven MAX field, not the component sum (50)
    db.close();
  });

  it('re-ingesting an identical line leaves the flagged row unchanged (no sum over the kept components)', () => {
    const db = openDb({ file: ':memory:' });
    const ledger = new SqliteLedger(db, defaultPricingEngine(), createNullEngine());
    ledger.upsertEvents([misalignedRow()]);
    const identical = makeEvent({ id: 'msg-misaligned', model: 'claude-sonnet-5', inputFresh: 50, output: 20, thinking: null });
    ledger.upsertEvents([identical]);
    const row = db.prepare('SELECT input_fresh, output FROM events WHERE id = ?').get('msg-misaligned') as unknown as { input_fresh: number; output: number };
    expect(row.input_fresh).toBe(100);
    expect(row.output).toBe(20);
    db.close();
  });

  it('an ordinary aligned duplicate is unchanged: tokens are the sum of its components', () => {
    const a = makeEvent({ id: 'msg-aligned', model: 'claude-sonnet-5', inputFresh: 100, output: 10, thinking: null });
    const b = makeEvent({ id: 'msg-aligned', model: 'claude-sonnet-5', inputFresh: 120, output: 30, thinking: null });
    const m = mergeDuplicateEvent(a, b);
    expect(m.flags).not.toContain('mergedComponentsMisaligned');
    expect(m.tokens.inputFresh).toBe(120);
    expect(m.tokens.output).toBe(30);
  });
});
