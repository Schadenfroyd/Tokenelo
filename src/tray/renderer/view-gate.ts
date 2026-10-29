/**
 * Coherence of the popover's async renders (src/tray/renderer/app.ts). Pure and DOM-agnostic, so the tests drive it directly.
 *
 * The problem it solves. A render awaits data, then writes the shared panel. Tab and range selections change immediately, so a
 * response for an earlier selection could land after a newer one and put its body under the current selection, or label one
 * range's data with another range. A late failure could remove a newer render's busy state, and a late response could fill a
 * cache that a refresh had just cleared (the caches are `RequestCache` instances, see request-cache.ts).
 *
 * The protocol.
 * - `begin(key)` starts a render for a tab and range. It makes that render the only current one. Earlier renders can still
 *   finish, but they can no longer commit, fail, or clear busy. The render builds into a staged container, not the panel.
 * - Every await in a render is followed by `view.current()`. A render that is no longer current returns without touching
 *   anything. The commit is the only write to the panel, and it happens only while the render is current.
 * - The visible body is cleared when the selection changes, so the body never shows another tab's or range's data under the
 *   current selection. A refresh of the same tab and range keeps the old body until the new one is committed, as before.
 * - Controls are never disabled here, and nothing is awaited before a new render starts. Old requests are not aborted.
 */

/** The selection a render belongs to. */
export interface ViewKey {
  readonly tab: string;
  readonly range: string;
}

/** The DOM operations the gate needs, supplied by app.ts (or by a test double). */
export interface ViewHost<S> {
  /** A detached container to build a body into. */
  createStage(): S;
  /** Replaces the visible body with the staged one. */
  commit(stage: S): void;
  /** Empties the visible body. */
  clear(): void;
  setBusy(busy: boolean): void;
  /** Readiness follows the current committed view, including during navigation after boot. */
  setReady(ready: boolean): void;
}

/** One render. `stage` is where the body goes; `current()` is false once a later render has begun. */
export interface View<S, K extends ViewKey> {
  readonly key: K;
  readonly stage: S;
  current(): boolean;
}

function sameKey(a: ViewKey | null, b: ViewKey): boolean {
  return a !== null && a.tab === b.tab && a.range === b.range;
}

export class ViewGate<S, K extends ViewKey> {
  private seq = 0;
  private epoch = 0;
  /** The selection whose body is currently visible (null: an empty body). */
  private shown: ViewKey | null = null;

  constructor(private readonly host: ViewHost<S>) {}

  /** Starts a render: supersedes every earlier one, clears the body if the selection changed, and sets busy. */
  begin(key: K): View<S, K> {
    const seq = ++this.seq;
    this.host.setReady(false);
    if (!sameKey(this.shown, key)) {
      this.host.clear();
      this.shown = null;
    }
    this.host.setBusy(true);
    return { key, stage: this.host.createStage(), current: () => seq === this.seq };
  }

  /** Commits a finished render, and clears busy, only if it is still current. */
  finish(view: View<S, K>): void {
    if (!view.current()) return;
    this.host.commit(view.stage);
    this.host.setBusy(false);
    this.shown = { tab: view.key.tab, range: view.key.range };
    this.host.setReady(true);
  }

  /** Commits an error body built by `build`, only if the render is still current. Busy is cleared only then. */
  fail(view: View<S, K>, build: (stage: S) => void): void {
    if (!view.current()) return;
    build(view.stage);
    this.host.commit(view.stage);
    this.host.setBusy(false);
    this.shown = { tab: view.key.tab, range: view.key.range };
  }
}
