/**
 * Cooperative yielding for collector loops. A collector whose per-file work is synchronous (stat,
 * SQLite point reads, JSON.parse of stored state) blocks the daemon's HTTP API for the whole loop
 * unless it returns to the event loop. Collectors yield when a YieldPacer says so, and after each
 * bounded read window.
 */
import { performance } from 'node:perf_hooks';

/**
 * Upper bound on files between yields. Kept as a cap, not the primary rule: a fixed count does not bound time,
 * because per-file cost varies with stored-state size and I/O.
 */
export const FILES_PER_YIELD = 200;

/**
 * Elapsed-time budget between yields. This is a proposed scheduling policy, not a measured bound. Evidence: on the real
 * growing copy, Codex stat plus state reads averaged about 0.21 ms per file (98,999.4 ms + 90,931 ms over 922,273 calls),
 * so 200 unchanged files are about 40 ms at that average. Per-file tails, unhooked phases and discovery may be larger, and
 * no 200-file chunk duration has been observed. The actual bounds stay open until the `*.file_sync` segments are measured.
 */
export const YIELD_BUDGET_MS = 10;

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Step-wise work: a generator that yields between bounded steps and returns its result. The synchronous caller drains it,
 * and the yielding caller pauses between steps when `pacing.due()` says so. The same code serves both, so results and order
 * are identical; only the pauses differ.
 */
export interface StepPacing {
  due(): boolean;
  yieldNow(): Promise<void>;
}

export function drainSteps<T>(steps: Generator<void, T, void>): T {
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

export async function drainStepsYielding<T>(steps: Generator<void, T, void>, pacing: StepPacing): Promise<T> {
  let r = steps.next();
  while (!r.done) {
    if (pacing.due()) await pacing.yieldNow();
    r = steps.next();
  }
  return r.value;
}

/**
 * Decides when a loop should yield: after `maxItems` units of work, or once `budgetMs` of clock time has passed since the
 * last yield, whichever comes first. The clock is injectable so tests can drive it deterministically.
 */
export class YieldPacer {
  private items = 0;
  private lastYieldMs: number;

  constructor(
    private readonly budgetMs: number = YIELD_BUDGET_MS,
    private readonly maxItems: number = FILES_PER_YIELD,
    private readonly clock: () => number = () => performance.now()
  ) {
    this.lastYieldMs = clock();
  }

  /** Counts one unit of synchronous work and reports whether the loop should yield before the next one. */
  due(): boolean {
    this.items++;
    return this.items >= this.maxItems || this.clock() - this.lastYieldMs >= this.budgetMs;
  }

  /** Call after the yield has completed. Restarts both the count and the clock. */
  yielded(): void {
    this.items = 0;
    this.lastYieldMs = this.clock();
  }
}
