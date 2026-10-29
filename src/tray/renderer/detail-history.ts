/**
 * Back navigation for the session-detail window (R45). Every load (boot, `onLoadSession` from the
 * popover, a subagent click/Enter/Space, the Back button) goes through `createDetailNavigator`,
 * which records history at intent time and then runs exactly one detail-load.ts intent. The loader
 * is unchanged: it still decides which response may paint (R42), so history never paints anything.
 *
 * History is two things: `ancestors`, the sessions Back can return to (newest last, at most
 * HISTORY_LIMIT), and `shown`, the last key the newest intent actually committed. A key is
 * `{source, sessionId}`; the same id under another source is a different session. History values
 * are frozen copies, never the caller's objects. No DOM here.
 */
import type { SessionDetail, Source } from './api-types.js';
import type { DetailKey, DetailLoader, DetailTicket } from './detail-load.js';

export const HISTORY_LIMIT = 32;

export interface DetailHistory {
  readonly ancestors: readonly DetailKey[];
  readonly shown: DetailKey | null;
}

export const EMPTY_HISTORY: DetailHistory = Object.freeze({ ancestors: Object.freeze([]) as readonly DetailKey[], shown: null });

export function sameKey(a: DetailKey | null | undefined, b: DetailKey | null | undefined): boolean {
  return !!a && !!b && a.source === b.source && a.sessionId === b.sessionId;
}

function copyKey(key: DetailKey): DetailKey {
  return Object.freeze({ source: key.source, sessionId: key.sessionId });
}

function history(ancestors: readonly DetailKey[], shown: DetailKey | null): DetailHistory {
  return Object.freeze({ ancestors: Object.freeze(ancestors.slice(-HISTORY_LIMIT)), shown });
}

/** A root load (boot or the popover) starts a new trail: no ancestors, nothing shown yet. */
export function rootIntent(): DetailHistory {
  return EMPTY_HISTORY;
}

/**
 * Opening a subagent records the session currently shown as its parent. Nothing is pushed when
 * nothing has been shown yet (a pending or failed root is not a parent), when the target is the
 * shown session (a refresh), or when the shown session is already the newest ancestor (a second
 * activation while the first child is still pending would otherwise add a ghost ancestor).
 */
export function childIntent(h: DetailHistory, target: DetailKey): DetailHistory {
  const shown = h.shown;
  if (!shown || sameKey(shown, target) || sameKey(shown, h.ancestors[h.ancestors.length - 1])) return h;
  return history([...h.ancestors, shown], shown);
}

/** Back pops the newest ancestor at intent time. Returns null when there is nowhere to go. */
export function backIntent(h: DetailHistory): { history: DetailHistory; target: DetailKey } | null {
  const target = h.ancestors[h.ancestors.length - 1];
  if (!target) return null;
  return { history: history(h.ancestors.slice(0, -1), h.shown), target };
}

/** Only the newest intent's success reaches this (via the loader's commit). */
export function committed(h: DetailHistory, key: DetailKey): DetailHistory {
  return history(h.ancestors, copyKey(key));
}

export function canGoBack(h: DetailHistory): boolean {
  return h.ancestors.length > 0;
}

/** What the renderer does with each step. detail.ts supplies the DOM version; tests a recording one. */
export interface DetailView {
  /** A new intent started: show the neutral pending state for `key` and the Back control state. */
  pending(key: DetailKey, canGoBack: boolean): void;
  success(detail: SessionDetail, ticket: DetailTicket): void;
  failure(err: unknown, ticket: DetailTicket): void;
  ready(ticket: DetailTicket): void;
}

export interface DetailNavigator {
  root(source: Source, sessionId: string): Promise<void>;
  child(source: Source, sessionId: string): Promise<void>;
  /** Does nothing (no fetch) when there is no ancestor. */
  back(): Promise<void>;
  readonly history: DetailHistory;
}

export function createDetailNavigator(loader: DetailLoader, view: DetailView): DetailNavigator {
  let current: DetailHistory = EMPTY_HISTORY;

  // History and the loader intent change together, synchronously, before any await.
  async function run(next: DetailHistory, key: DetailKey): Promise<void> {
    current = next;
    view.pending(key, canGoBack(current));
    const { outcome } = loader.begin(key.source, key.sessionId);
    loader.commit(await outcome, {
      success: (detail, ticket) => {
        current = committed(current, ticket.key);
        view.success(detail, ticket);
      },
      failure: (err, ticket) => view.failure(err, ticket),
      ready: (ticket) => view.ready(ticket),
    });
  }

  return {
    root: (source, sessionId) => run(rootIntent(), copyKey({ source, sessionId })),
    child: (source, sessionId) => {
      const key = copyKey({ source, sessionId });
      return run(childIntent(current, key), key);
    },
    back: () => {
      const step = backIntent(current);
      return step ? run(step.history, step.target) : Promise.resolve();
    },
    get history() {
      return current;
    },
  };
}
