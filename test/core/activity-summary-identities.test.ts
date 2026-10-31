import { describe, expect, it } from 'vitest';
import { ActivityGroupingIdentities, summedSessionActiveMsSteps, type ActivityGroupingEvent } from '../../src/core/activity-summary.js';
import { buildParentMap } from '../../src/core/sessions.js';
import { drainSteps } from '../../src/core/event-loop.js';
import type { ActivityMark } from '../../src/core/types.js';

function compact(events: ActivityGroupingEvent[]) {
  const identities = new ActivityGroupingIdentities(); for (const event of events) identities.add(event); return identities.events();
}
function event(sessionId: string, parentSessionId?: string, host = 'H', source: ActivityGroupingEvent['source'] = 'codex'): ActivityGroupingEvent {
  return { host, source, sessionId, parentSessionId, isSubagent: parentSessionId !== undefined };
}

describe('Summary timer identity retention', () => {
  it('retains the final parent independently when the same child id appears on another host', () => {
    const events = [event('C', 'A', 'H', 'claude'), event('C', 'B', 'H', 'claude'), event('C', 'A', 'Other', 'claude')];
    const marks: ActivityMark[] = [
      { host: 'H', source: 'claude', sessionId: 'C', ts: 100 },
      { host: 'H', source: 'claude', sessionId: 'B', ts: 200 },
    ];
    expect(drainSteps(summedSessionActiveMsSteps(marks, compact(events), 1000))).toBe(100);
    expect(drainSteps(summedSessionActiveMsSteps(marks, events, 1000))).toBe(100);
  });

  it('retains the final valid parent when an interleaved child switches back to an earlier parent', () => {
    const events = [event('child', 'A'), event('A'), event('child', 'B'), event('B'), event('child', 'A'), event('child')];
    const retained = compact(events);
    expect(retained).toHaveLength(4); expect(buildParentMap(retained).get('child')).toBe('A');
    expect(retained).toEqual([events[0], events[1], events[3], events[4]]);
  });

  it('keeps global UUID ownership, host/source grouping, final ancestry and fractional active time identical', () => {
    const events = [event('child', 'A'), event('other'), event('child', 'B'), event('A'), event('B'),
      event('child', 'A', 'Other', 'claude'), event('child', ''), event('child', 'child'), event('other')];
    const marks: ActivityMark[] = [
      { host: 'H', source: 'codex', sessionId: 'child', ts: 100, uuid: 'copied', durationMs: 0.25 },
      { host: 'H', source: 'codex', sessionId: 'other', ts: 100, uuid: 'copied', durationMs: 0.5 },
      { host: 'H', source: 'codex', sessionId: 'A', ts: 200, durationMs: 0.75 },
      { host: 'Other', source: 'claude', sessionId: 'child', ts: 101, durationMs: 0.1 },
      { host: 'H', source: 'codex', sessionId: 'marks-only', ts: 300, durationMs: 0.2 },
    ];
    const retained = compact(events);
    expect(buildParentMap(retained).get('child')).toBe(buildParentMap(events).get('child'));
    expect(drainSteps(summedSessionActiveMsSteps(marks, retained, 1000))).toBe(drainSteps(summedSessionActiveMsSteps(marks, events, 1000)));
  });

  it('retains one repeated identity without dropping distinct host/source/session tuples', () => {
    const repeated = Array.from({ length: 10000 }, () => event('s'));
    const events = [...repeated, event('s', undefined, 'Other'), event('s', undefined, 'H', 'claude'), event('s\0other')];
    expect(compact(events)).toHaveLength(4); expect(compact([])).toEqual([]);
  });
});
