/**
 * The session build as steps (core/sessions.ts). The yielding build must return exactly what the synchronous build returns,
 * and it must actually pause between steps. The explicit expectations below are computed from the fixture's construction,
 * not from either build, so a mutation shared by both builds is still caught.
 */
import { describe, expect, it } from 'vitest';
import { buildSessions, buildSessionsYielding } from '../../src/core/sessions.ts';
import { ZERO_TOKENS } from '../../src/core/types.ts';
import type { ActivityMark, UsageComponent, UsageEvent } from '../../src/core/types.ts';

function mkEvent(o: { id: string; ts: number; sessionId: string; source?: UsageEvent['source']; model?: string; project?: string; isSubagent?: boolean; parentSessionId?: string }): UsageEvent {
  const tokens = { ...ZERO_TOKENS, inputFresh: 10, output: 5 };
  const component: UsageComponent = { model: o.model ?? 'claude-sonnet-5', tokens };
  return {
    id: o.id,
    host: 'M4a',
    source: o.source ?? 'claude',
    ts: o.ts,
    tsSource: 'line',
    sessionId: o.sessionId,
    parentSessionId: o.parentSessionId,
    isSubagent: o.isSubagent ?? false,
    project: o.project,
    model: o.model ?? 'claude-sonnet-5',
    provider: 'anthropic',
    components: [component],
    tokens,
    flags: [],
    apiEquivUsd: 0,
    priceStatus: 'LIST',
    priceVersion: 'v1',
    reservedValue: 0,
    ucuRateStatus: 'MEASURED',
    eacsDefSha256: 'sha',
  } as UsageEvent;
}

function mkMark(o: { sessionId: string; ts: number; uuid?: string; source?: ActivityMark['source']; durationMs?: number }): ActivityMark {
  return { source: o.source ?? 'claude', sessionId: o.sessionId, ts: o.ts, uuid: o.uuid, host: 'M4a', durationMs: o.durationMs };
}

const NOW = 2_000_000_000;
const OPTS = { idleGapMs: 300_000, now: () => NOW };
const PARENTS = 60;
const EVENTS_PER_PARENT = 80;
const MARKS_PER_PARENT = 40;

/** 60 parent sessions, every fifth with one subagent; a Codex session with turn durations; some duplicated line uuids. */
function fixture(): { events: UsageEvent[]; marks: ActivityMark[] } {
  const events: UsageEvent[] = [];
  const marks: ActivityMark[] = [];
  for (let p = 0; p < PARENTS; p++) {
    const id = `p-${String(p).padStart(3, '0')}`;
    for (let k = 0; k < EVENTS_PER_PARENT; k++) {
      events.push(mkEvent({
        id: `${id}-${k}`,
        sessionId: id,
        ts: 1_000_000 + k * 5_000 + p,
        // k = 0 has no project; k = 1 names the session's project; later events name other projects, so the first own
        // event and the last own event differ.
        project: k === 0 ? undefined : k === 1 ? `proj-${p % 4}` : `late-${k}`,
        model: k % 3 === 0 ? 'other-model' : 'claude-sonnet-5',
      }));
    }
    if (p % 5 === 0) {
      const sub = `${id}-sub`;
      for (let k = 0; k < 3; k++) {
        events.push(mkEvent({ id: `${sub}-${k}`, sessionId: sub, parentSessionId: id, isSubagent: true, ts: 1_000_100 + k * 5_000 + p }));
      }
    }
    for (let k = 0; k < MARKS_PER_PARENT; k++) {
      const ts = 1_000_000 + k * 30_000;
      marks.push(mkMark({ sessionId: id, ts, uuid: `u-${id}-${k}` }));
      if (k % 7 === 0) marks.push(mkMark({ sessionId: 'q-dup', ts: ts + 1000, uuid: `u-${id}-${k}` })); // a later copy: dropped
    }
  }
  for (let k = 0; k < 5; k++) marks.push(mkMark({ sessionId: 'cx-1', source: 'codex', ts: 1_000_000 + k * 60_000, uuid: `cx-${k}`, durationMs: 1000 }));
  return { events, marks };
}

describe('buildSessionsYielding', () => {
  it('returns exactly what buildSessions returns, and pauses between steps', async () => {
    const { events, marks } = fixture();
    const sync = buildSessions(marks, events, OPTS);
    let pauses = 0;
    const yielding = await buildSessionsYielding(marks, events, OPTS, {
      due: () => true,
      yieldNow: async () => {
        pauses++;
      },
    });
    expect(yielding).toEqual(sync);
    // 4,836 events and 2,400+ marks in steps of 2,000 items, plus one step per session group (61 groups).
    expect(pauses).toBeGreaterThanOrEqual(60);
  });

  it('gives the explicit expected rows, computed from the fixture', async () => {
    const { events, marks } = fixture();
    const rows = await buildSessionsYielding(marks, events, OPTS, { due: () => false, yieldNow: async () => {} });

    // 60 parents plus the Codex session. Subagents are folded into their parent, not separate rows; the later duplicate
    // marks in q-dup are dropped, so no q-dup row exists.
    expect(rows).toHaveLength(PARENTS + 1);
    expect(rows.some((r) => r.sessionId === 'q-dup')).toBe(false);
    for (let p = 0; p < PARENTS; p++) {
      const row = rows.find((r) => r.sessionId === `p-${String(p).padStart(3, '0')}`)!;
      // First own event with a project: k = 1 (k = 0 has none), so the project is the parent's modulo group.
      expect(row.project).toBe(`proj-${p % 4}`);
      expect(row.subagents).toBe(p % 5 === 0 ? 1 : 0);
      // 40 marks, 30 s apart, all within the idle gap: 39 gaps of 30 s.
      expect(row.activeMs).toBe((MARKS_PER_PARENT - 1) * 30_000);
      expect(row.start).toBe(1_000_000); // every parent's first mark is at 1,000,000, earlier than any of its events
    }
    const codex = rows.find((r) => r.sessionId === 'cx-1')!;
    expect(codex.activeMs).toBe(5 * 1000); // Codex: turn durations are authoritative
    expect(rows.map((r) => r.start)).toEqual([...rows.map((r) => r.start)].sort((a, b) => a - b));
  });
});
