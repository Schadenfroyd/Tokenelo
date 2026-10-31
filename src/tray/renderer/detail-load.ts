/**
 * Load identity for the session-detail window (R42). Boot, `onLoadSession` and subagent
 * click/Enter/Space each start one load intent. Responses can arrive out of order, so every intent
 * captures its own `{source, sessionId}` key and a monotonic generation, and only the newest intent
 * may change what the window shows.
 *
 * Two checks close the gap. `request` classifies a settled fetch as `current` / `current-error` /
 * `superseded`. That classification can itself go stale while the caller's `await` continuation is
 * queued, so `commit` checks the generation again at the synchronous UI commit point. After a
 * success it checks once more before `ready`, in case painting started a newer intent. No DOM here.
 */
import type { SessionDetail, Source } from './api-types.js';

export interface DetailKey {
  source: Source;
  sessionId: string;
}

export interface DetailTicket {
  readonly key: DetailKey;
  readonly generation: number;
}

export type DetailOutcome =
  | { kind: 'current'; ticket: DetailTicket; detail: SessionDetail }
  | { kind: 'current-error'; ticket: DetailTicket; err: unknown }
  | { kind: 'superseded'; ticket: DetailTicket };

export interface DetailCommit {
  success(detail: SessionDetail, ticket: DetailTicket): void;
  failure(err: unknown, ticket: DetailTicket): void;
  /** Runs only after a success that is still the newest intent. Errors never reach it. */
  ready?(ticket: DetailTicket): void;
}

/** Fixed and non-sensitive: it names neither the requested nor the returned session. */
export const DETAIL_IDENTITY_MISMATCH = 'The response did not match the requested session.';

/**
 * SessionDetail extends SessionRow, where `source` and `sessionId` are required, and the renderer
 * uses `source` for the chart and child navigation. A response must be a non-null object carrying
 * exactly the requested key; null, a non-object, or missing/mistyped/other identity is refused.
 */
function identityMatches(key: DetailKey, detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null) return false;
  const d = detail as { source?: unknown; sessionId?: unknown };
  return d.source === key.source && d.sessionId === key.sessionId;
}

export interface DetailLoader {
  /** Starts one intent: exactly one fetch with the captured key, called before any await. */
  begin(source: Source, sessionId: string): { ticket: DetailTicket; outcome: Promise<DetailOutcome> };
  isCurrent(ticket: DetailTicket): boolean;
  /** Rechecks the generation, then calls the matching handler synchronously. Returns whether it committed. */
  commit(outcome: DetailOutcome, handlers: DetailCommit): boolean;
}

export function createDetailLoader(fetch: (source: Source, sessionId: string) => Promise<SessionDetail>): DetailLoader {
  let latest = 0;

  function isCurrent(ticket: DetailTicket): boolean {
    return ticket.generation === latest;
  }

  async function settle(ticket: DetailTicket, pending: Promise<SessionDetail>): Promise<DetailOutcome> {
    let detail: SessionDetail;
    try {
      detail = await pending;
    } catch (err) {
      return isCurrent(ticket) ? { kind: 'current-error', ticket, err } : { kind: 'superseded', ticket };
    }
    if (!isCurrent(ticket)) return { kind: 'superseded', ticket };
    if (!identityMatches(ticket.key, detail)) return { kind: 'current-error', ticket, err: new Error(DETAIL_IDENTITY_MISMATCH) };
    return { kind: 'current', ticket, detail };
  }

  function begin(source: Source, sessionId: string): { ticket: DetailTicket; outcome: Promise<DetailOutcome> } {
    latest += 1;
    const ticket: DetailTicket = { key: Object.freeze({ source, sessionId }), generation: latest };
    let pending: Promise<SessionDetail>;
    try {
      pending = Promise.resolve(fetch(ticket.key.source, ticket.key.sessionId));
    } catch (err) {
      pending = Promise.reject(err);
    }
    return { ticket, outcome: settle(ticket, pending) };
  }

  function commit(outcome: DetailOutcome, handlers: DetailCommit): boolean {
    if (outcome.kind === 'superseded' || !isCurrent(outcome.ticket)) return false;
    if (outcome.kind === 'current-error') {
      handlers.failure(outcome.err, outcome.ticket);
      return true;
    }
    handlers.success(outcome.detail, outcome.ticket);
    if (handlers.ready && isCurrent(outcome.ticket)) handlers.ready(outcome.ticket);
    return true;
  }

  return { begin, isCurrent, commit };
}
