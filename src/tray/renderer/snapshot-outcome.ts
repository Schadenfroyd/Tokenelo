/** Shared, DOM-free snapshot protocol. Failure categories carry no raw error, identity or path. */
export type SnapshotFailure = 'detail-identity' | 'detail-load' | 'renderer-load';
const FAILURE_TEXT: ReadonlyMap<string, string> = new Map([
  ['detail-identity', 'the detail response did not match the requested session'],
  ['detail-load', 'the session detail could not be loaded'],
  ['renderer-load', 'the renderer could not finish loading'],
]);

export class SnapshotRendererError extends Error {
  readonly category: SnapshotFailure | null;
  constructor(category: unknown) {
    super(snapshotRendererFailureText(category));
    this.category = typeof category === 'string' && FAILURE_TEXT.has(category) ? category as SnapshotFailure : null;
    this.name = 'SnapshotRendererError';
  }
}

export function snapshotRendererFailureText(category: unknown): string {
  return typeof category === 'string' ? FAILURE_TEXT.get(category) ?? 'the renderer reported an invalid outcome' : 'the renderer reported an invalid outcome';
}

export function assertSnapshotOutcome(outcome: unknown): void {
  if (outcome !== null && typeof outcome === 'object') {
    const value = outcome as { ok?: unknown; category?: unknown };
    if (value.ok === true && value.category == null) return;
    throw new SnapshotRendererError(value.category);
  }
  throw new SnapshotRendererError(null);
}

/** Executed in the real renderer main world by Electron. Subscribe before reading current state,
 * so an already settled outcome and a later event use the same path; always remove both listeners. */
export const SNAPSHOT_OUTCOME_WAIT_SCRIPT = `new Promise((resolve) => {
  const settle = () => {
    const category = window.__tokeneloFailure;
    if (!category && window.__tokeneloReady !== true) return;
    window.removeEventListener('tokenelo:ready', settle);
    window.removeEventListener('tokenelo:failed', settle);
    resolve(category ? { ok: false, category } : { ok: true });
  };
  window.addEventListener('tokenelo:ready', settle);
  window.addEventListener('tokenelo:failed', settle);
  settle();
})`;
