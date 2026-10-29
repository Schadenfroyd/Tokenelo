import type { LocalValue, ModelRow, SessionRow } from './api-types.js';

export interface LocalModelSessionMatch {
  session: SessionRow;
  evidence: 'telemetry' | 'legacy-model-list';
}

export function localModelSessionDrilldownAllowed(local: Pick<LocalValue, 'readEvidence'>): boolean {
  return !(local.readEvidence?.version === 1 && local.readEvidence.state === 'malformed-components');
}

/**
 * Match session summaries that explicitly contain a local model identity. This returns
 * whole session rows, never model-level counts; those totals may include other models.
 */
export function localModelSessionMatches(
  row: Pick<ModelRow, 'model' | 'source' | 'provider'>,
  sessions: readonly SessionRow[],
): LocalModelSessionMatch[] {
  const matches: LocalModelSessionMatch[] = [];
  if (row.provider !== 'local') return matches;
  for (const session of sessions) {
    if (session.source !== row.source) continue;
    if (Array.isArray(session.telemetry)) {
      const hasExactFeed = session.telemetry.some((feed) => !!feed
        && feed.host === session.host
        && feed.source === row.source
        && feed.provider === 'local'
        && Number.isSafeInteger(feed.events)
        && feed.events > 0
        && Array.isArray(feed.models)
        && feed.models.includes(row.model));
      if (hasExactFeed) matches.push({ session, evidence: 'telemetry' });
      continue;
    }
    if (session.telemetry !== undefined) continue;
    if (Array.isArray(session.models) && session.models.includes(row.model)) matches.push({ session, evidence: 'legacy-model-list' });
  }
  return matches.sort((a, b) => b.session.end - a.session.end || a.session.sessionId.localeCompare(b.session.sessionId));
}
