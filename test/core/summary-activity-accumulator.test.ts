import { describe, expect, it } from 'vitest';
import { drainSteps } from '../../src/core/event-loop.js';
import { dedupeActivityMarks } from '../../src/core/sessions.js';
import {
  SummaryActivityAccumulator,
  summedSessionActiveMsSteps,
  type ActivityGroupingEvent,
} from '../../src/core/activity-summary.js';
import type { ActivityMark } from '../../src/core/types.js';

type OrderedMark = { rowid: number; mark: ActivityMark };

function event(host: string, source: ActivityGroupingEvent['source'], sessionId: string, parentSessionId?: string): ActivityGroupingEvent {
  return { host, source, sessionId, ...(parentSessionId ? { parentSessionId, isSubagent: true } : { isSubagent: false }) };
}

function mark(host: string, source: ActivityMark['source'], sessionId: string, ts: number,
  extra: Partial<Pick<ActivityMark, 'uuid' | 'durationMs'>> = {}): ActivityMark {
  return { host, source, sessionId, ts, ...extra };
}

function canonical(rows: readonly OrderedMark[]): OrderedMark[] {
  return [...rows].sort((a, b) => a.mark.ts - b.mark.ts || a.rowid - b.rowid);
}

function referenceWall(timestamps: readonly number[], idleGapMs: number): number {
  const ordered = [...timestamps].sort((a, b) => a - b);
  const intervals: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < ordered.length; i++) {
    const start = ordered[i - 1]!;
    const end = ordered[i]!;
    if (end > start && end - start <= idleGapMs) intervals.push({ start, end });
  }
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of intervals) {
    if (start === undefined || end === undefined || interval.start > end) {
      if (start !== undefined && end !== undefined) total += end - start;
      start = interval.start;
      end = interval.end;
    } else if (interval.end > end) end = interval.end;
  }
  if (start !== undefined && end !== undefined) total += end - start;
  return total;
}

function reference(rows: readonly OrderedMark[], events: readonly ActivityGroupingEvent[], idleGapMs: number) {
  const ordered = canonical(rows);
  const marks = ordered.map((row) => row.mark);
  return {
    agentMs: drainSteps(summedSessionActiveMsSteps(marks, events, idleGapMs)),
    wallMs: referenceWall(dedupeActivityMarks(marks).map((row) => row.ts), idleGapMs),
  };
}

function streamed(rows: readonly OrderedMark[], events: readonly ActivityGroupingEvent[], idleGapMs: number) {
  const accumulator = new SummaryActivityAccumulator(events, idleGapMs);
  for (const row of canonical(rows)) accumulator.add(row.mark, row.rowid);
  return drainSteps(accumulator.finishSteps());
}

describe('SummaryActivityAccumulator', () => {
  it('matches global UUID ownership, parent folding, per-source duration precedence, gaps, and wall time', () => {
    const events = [
      event('A2000', 'codex', 'root'),
      event('A2000', 'codex', 'child', 'root'),
      event('A2000', 'claude', 'claude-root'),
      event('M4a', 'claude', 'other-host'),
    ];
    const rows: OrderedMark[] = [
      { rowid: 1, mark: mark('A2000', 'codex', 'child', 100, { uuid: 'copied', durationMs: 25 }) },
      { rowid: 2, mark: mark('A2000', 'codex', 'root', 120, { durationMs: 0 }) },
      { rowid: 3, mark: mark('A2000', 'claude', 'claude-root', 150, { uuid: '' }) },
      { rowid: 4, mark: mark('M4a', 'claude', 'other-host', 175, { uuid: 'copied' }) },
      { rowid: 5, mark: mark('A2000', 'claude', 'marks-only', 300) },
      { rowid: 6, mark: mark('A2000', 'claude', 'marks-only', 450) },
      { rowid: 7, mark: mark('A2000', 'claude', 'marks-only', 900) },
    ];
    expect(streamed(rows, events, 200)).toEqual(reference(rows, events, 200));
  });

  it('preserves no-UUID-before-UUID order for equal-time duration sums', () => {
    const events = [event('A2000', 'codex', 'turns')];
    const rows: OrderedMark[] = [
      { rowid: 1, mark: mark('A2000', 'codex', 'turns', 100, { uuid: 'large', durationMs: 10_000_000_000_000_000 }) },
      { rowid: 2, mark: mark('A2000', 'codex', 'turns', 100, { durationMs: 1 }) },
      { rowid: 3, mark: mark('A2000', 'codex', 'turns', 100, { durationMs: 1 }) },
      { rowid: 4, mark: mark('A2000', 'codex', 'turns', 200, { uuid: 'large', durationMs: 999 }) },
    ];
    expect(streamed(rows, events, 300)).toEqual(reference(rows, events, 300));
  });

  it('dedupes copied UUID timestamps from wall time as well as agent time', () => {
    const events = [event('A2000', 'claude', 's')];
    const rows: OrderedMark[] = [
      { rowid: 1, mark: mark('A2000', 'claude', 's', 100, { uuid: 'same' }) },
      { rowid: 2, mark: mark('A2000', 'claude', 's', 200) },
      { rowid: 3, mark: mark('A2000', 'claude', 's', 10_000, { uuid: 'same' }) },
      { rowid: 4, mark: mark('A2000', 'claude', 's', 10_100) },
    ];
    const result = streamed(rows, events, 300);
    expect(result).toEqual(reference(rows, events, 300));
    expect(result).toEqual({ agentMs: 100, wallMs: 100 });
  });

  it('retains distinct UUIDs and timestamps without a UUID in both time measures', () => {
    for (const uuid of ['different', null]) {
      const rows: OrderedMark[] = [
        { rowid: 1, mark: mark('A2000', 'claude', 's', 100, { uuid: 'first' }) },
        { rowid: 2, mark: mark('A2000', 'claude', 's', 200) },
        { rowid: 3, mark: mark('A2000', 'claude', 's', 10_000, uuid ? { uuid } : {}) },
        { rowid: 4, mark: mark('A2000', 'claude', 's', 10_100) },
      ];
      expect(streamed(rows, [event('A2000', 'claude', 's')], 300)).toEqual({ agentMs: 200, wallMs: 200 });
    }
  });

  it('returns zero for an empty mark population even when event-only groups exist', () => {
    const events = [event('A2000', 'codex', 'empty'), event('M4a', 'claude', 'empty')];
    expect(streamed([], events, 300)).toEqual({ agentMs: 0, wallMs: 0 });
  });

  it('rejects non-canonical row order instead of changing UUID ownership', () => {
    const accumulator = new SummaryActivityAccumulator([], 300);
    accumulator.add(mark('A2000', 'claude', 's', 200, { uuid: 'same' }), 2);
    expect(() => accumulator.add(mark('A2000', 'claude', 's', 100, { uuid: 'same' }), 1)).toThrow(/ordered by \(ts,rowid\)/);
  });

  it('matches the reference for deterministic mixed host/source and duplicate-UUID populations', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const events: ActivityGroupingEvent[] = [];
      for (let i = 0; i < 18; i++) {
        const host = i % 2 ? 'A2000' : 'M4a';
        const source: ActivityGroupingEvent['source'] = i % 3 ? 'claude' : 'codex';
        const sessionId = `s${i % 7}`;
        const isSubagent = i % 4 === 0;
        const parent = isSubagent ? `s${(i + seed + 1) % 7}` : undefined;
        events.push(event(host, source, sessionId, parent));
      }
      const rows: OrderedMark[] = [];
      for (let i = 0; i < 140; i++) {
        const source: ActivityMark['source'] = i % 3 ? 'claude' : 'codex';
        const host = i % 2 ? 'A2000' : 'M4a';
        const extra: Partial<Pick<ActivityMark, 'uuid' | 'durationMs'>> = {};
        if (i % 5 !== 0) extra.uuid = i % 17 === 0 ? `copy-${seed}-${i % 8}` : `u-${seed}-${i}`;
        if (i % 4 === 0) extra.durationMs = i / 4;
        rows.push({ rowid: i + 1, mark: mark(host, source, `s${i % 11}`, Math.floor(i / 3) * 50, extra) });
      }
      expect(streamed(rows, events, 250 + seed)).toEqual(reference(rows, events, 250 + seed));
    }
  });
});
