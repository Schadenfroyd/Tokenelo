/**
 * A profiling segment must cover only synchronous work. The clock is driven by hand, so a wait is a jump in the clock
 * and the expected durations are exact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { awaitOutside, createProfiler, setActiveProfiler, stopProfiler, SyncSegment, type ProfileSink } from '../../src/core/phase-profile.js';

afterEach(() => {
  stopProfiler();
});

function manualProfiler(): { setClock(t: number): void; stats(): Record<string, { count: number; totalMs: number; maxMs: number }> } {
  let t = 1;
  const profile: Array<Record<string, unknown>> = [];
  const sink: ProfileSink = { write: (l) => profile.push(l), flush: () => {} };
  const profiler = createProfiler({ sink, now: () => t, windowStartMs: 0 });
  setActiveProfiler(profiler);
  return {
    setClock(next) {
      t = next;
    },
    stats() {
      profiler.flushStats(t);
      return profile.find((l) => l.type === 'stats')!.phases as Record<string, { count: number; totalMs: number; maxMs: number }>;
    },
  };
}

describe('SyncSegment and awaitOutside', () => {
  it('records the synchronous runs on either side of an await and not the wait between them', async () => {
    const p = manualProfiler();
    const seg = new SyncSegment('work'); // opens at t = 1
    p.setClock(5); // 4 ms of synchronous work
    await awaitOutside(seg, async () => p.setClock(105)); // a 100 ms wait, which must not be counted
    p.setClock(107); // 2 ms of synchronous work
    seg.close();

    expect(p.stats()['work']).toEqual({ count: 2, totalMs: 6, maxMs: 4 });
  });

  it('a segment closed without an await records one run', () => {
    const p = manualProfiler();
    const seg = new SyncSegment('work');
    p.setClock(3);
    seg.close();
    seg.close(); // closing again records nothing

    expect(p.stats()['work']).toEqual({ count: 1, totalMs: 2, maxMs: 2 });
  });

  it('resumes the segment when the awaited work rejects, so later synchronous work is still recorded', async () => {
    const p = manualProfiler();
    const seg = new SyncSegment('work');
    p.setClock(4);
    await expect(
      awaitOutside(seg, async () => {
        p.setClock(50);
        throw new Error('io failed');
      })
    ).rejects.toThrow('io failed');
    p.setClock(52);
    seg.close();

    expect(p.stats()['work']).toEqual({ count: 2, totalMs: 5, maxMs: 3 });
  });
});
