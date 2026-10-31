import type { DoctorReport } from './api-types.js';
import { priceFieldLabel, priceFieldState } from './price-evidence.js';

export interface DoctorSummaryRow {
  label: string;
  value: string;
  note: string;
}

export interface DoctorBuildIdentityBadge {
  text: string;
  state: 'matching' | 'matching-dirty' | 'mismatch' | 'unknown';
  note: string;
}

/** Compact Doctor-header identity status; raw source and manifest hashes stay out of the renderer. */
export function doctorBuildIdentityBadge(report: DoctorReport): DoctorBuildIdentityBadge {
  const identity = report.runtimeBuildIdentity;
  const state = identity?.state === 'matching' || identity?.state === 'matching-dirty' || identity?.state === 'mismatch'
    ? identity.state : 'unknown';
  const observedAt = identity?.observedAt;
  const healthClock = typeof observedAt === 'number' && Number.isSafeInteger(observedAt) && observedAt >= 0 && observedAt <= 8.64e15
    ? new Date(observedAt).toISOString() : null;
  const note = state === 'matching'
    ? 'Tray and daemon report the same clean source and distribution identity. This does not prove loaded code or complete capture.'
    : state === 'matching-dirty'
      ? 'Tray and daemon report the same identity, but the source is marked dirty; this is not release evidence.'
      : state === 'mismatch'
        ? 'Tray and daemon report different package identities. This does not identify which component produced stored data.'
        : 'One or both components did not report a complete identity. Unknown is not a match or mismatch.';
  return {
    text: state === 'matching' ? 'Build: Match' : state === 'matching-dirty' ? 'Build: Dirty' : state === 'mismatch' ? 'Build: Mismatch' : 'Build: Unknown',
    state,
    note: `${note} ${healthClock ? `Authenticated health read: ${healthClock}.` : 'Health observation time unavailable; this is separate from the stored-history report clock.'}`,
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sum(values: unknown[] | undefined): number | null {
  if (!values) return null;
  let total = 0;
  for (const value of values) {
    const next = count(value);
    if (next === null || !Number.isSafeInteger(total + next)) return null;
    total += next;
  }
  return total;
}

function amount(value: number | null, singular: string, plural: string): string {
  return value === null ? 'Evidence unavailable' : `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

const MAX_UNMATCHED_MODELS = 5;
const MAX_OLLAMA_SERVER_ROWS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fileName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const clean = value.trim().replace(/[\\/]+$/, '');
  const name = clean.split(/[\\/]/).pop();
  return name || null;
}

function reportClock(value: unknown): string {
  const ms = count(value);
  const date = ms === null ? null : new Date(ms);
  return date && Number.isFinite(date.getTime())
    ? `Doctor report generated ${date.toLocaleString()}.`
    : 'Doctor report time unavailable.';
}

function unmatchedModelsRow(value: unknown): { value: string; note: string } {
  if (!Array.isArray(value)) {
    return { value: 'Evidence unavailable', note: 'Unmatched model details are unavailable in this report; absence does not mean zero.' };
  }
  const rows: Array<{ model: string; events: unknown }> = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item.model !== 'string' || item.model.length === 0) {
      return { value: 'Evidence unavailable', note: 'Unmatched model details are incomplete in this report; absence does not mean zero.' };
    }
    rows.push({ model: item.model, events: item.events });
  }
  if (rows.length === 0) return { value: '0 models', note: 'No unmatched model IDs were reported in this Doctor report.' };
  const shown = rows.slice(0, MAX_UNMATCHED_MODELS)
    .map((row) => `${row.model} · ${amount(count(row.events), 'event', 'events')}`);
  const extra = rows.length > shown.length ? `; ${(rows.length - shown.length).toLocaleString()} additional model IDs omitted` : '';
  return {
    value: amount(count(rows.length), 'model', 'models'),
    note: `Stored unmatched model IDs: ${shown.join('; ')}${extra}. Event counts are per model; no dollar amount is inferred.`,
  };
}

function ollamaServerRows(value: unknown, generatedAt: unknown): { value: string; note: string } {
  if (!Array.isArray(value)) {
    return { value: 'Evidence unavailable', note: 'Ollama server/log identity is unavailable in this report; absence does not mean zero servers.' };
  }
  const clock = reportClock(generatedAt);
  if (value.length === 0) {
    return {
      value: '0 server rows',
      note: `${clock} No reachable-server rows were returned. Review reported warnings for listeners that did not answer /api/version; an empty list does not prove no process is listening.`,
    };
  }
  const details = value.slice(0, MAX_OLLAMA_SERVER_ROWS).map((item, index) => {
    if (!isRecord(item)) return `server ${index + 1}: identity unavailable`;
    const address = typeof item.address === 'string' && item.address.length > 0 ? item.address : 'address unavailable';
    const family = item.family === 'IPv4' || item.family === 'IPv6' ? item.family : 'family unavailable';
    const version = typeof item.version === 'string' && item.version.length > 0 ? item.version : 'version unavailable';
    const binary = fileName(item.binary) ?? 'process identity unavailable';
    const log = fileName(item.logPath) ?? 'log filename unavailable';
    const logState = typeof item.logAvailable === 'boolean'
      ? item.logAvailable ? 'available' : 'unavailable'
      : 'status unavailable';
    return `${address} (${family}) · Ollama ${version} · process ${binary} · log ${log} (${logState})`;
  });
  const extra = value.length > details.length ? `; ${(value.length - details.length).toLocaleString()} additional server rows omitted` : '';
  return {
    value: amount(count(value.length), 'server row', 'server rows'),
    note: `${clock} Server/log identities: ${details.join('; ')}${extra}. Directory prefixes are omitted from this local Doctor summary; log availability is shown separately.`,
  };
}

function queueClock(value: unknown): string {
  const ms = count(value); const date = ms === null ? null : new Date(ms);
  return date && Number.isFinite(date.getTime()) ? `Observed ${date.toLocaleString()}. ` : 'Queue observation time unavailable. ';
}

function queueNote(backlog: NonNullable<NonNullable<DoctorReport['ollama']>['backlog']>): string {
  const unknown = count(backlog.pending) === null || count(backlog.quarantined) === null || count(backlog.writeFailures) === null;
  const unknownFlags = (backlog.historyIncomplete !== undefined && typeof backlog.historyIncomplete !== 'boolean')
    || (backlog.failureEvidenceStored !== undefined && backlog.failureEvidenceStored !== null && typeof backlog.failureEvidenceStored !== 'boolean');
  const review = unknown || unknownFlags || backlog.historyIncomplete === true || backlog.failureEvidenceStored === false
    || (count(backlog.quarantined) ?? 0) > 0 || (count(backlog.writeFailures) ?? 0) > 0;
  if (!review) return queueClock(backlog.observedAt) + 'Current local queue observation, separate from this historical report. Waiting requests are excluded from recorded totals; zero does not prove complete capture.';
  return queueClock(backlog.observedAt) + 'Capture needs review. Invalid observations or storage errors were reported or could not be checked; some observations may have recovered or could not be saved; usage history may be incomplete.'
    + (unknown ? ' Diagnostic counts are unavailable.' : '')
    + (unknownFlags ? ' Diagnostic evidence is unavailable.' : '')
    + (backlog.historyIncomplete === true ? ' Failure history is incomplete; known counts are a lower bound.' : '')
    + (backlog.failureEvidenceStored === false ? ' Failure evidence could not be stored and may not survive restart.' : '');
}

function codexQualityNote(codex: DoctorReport['codex'] | undefined): string {
  if (!codex) return ' Additional Codex count-quality evidence is unavailable; absence does not mean zero.';
  const fields: Array<[string, number | null]> = [
    ['inherited/replay files', count(codex.inheritedBaselineFiles)],
    ['counter-reset files', count(codex.resetFiles)],
    ['record-derived token_count files', count(codex.recordReconciledFiles)],
    ['non-zero cache-write events', count(codex.nonZeroCacheWrite)],
    ['own-in-wrapper files', count(codex.ownInWrapperFiles)],
    ['own-in-wrapper events', count(codex.ownInWrapperEvents)],
    ['trailing-record files', count(codex.trailingRecordFiles)],
  ];
  if (fields.every(([, value]) => value === null)) {
    return ' Additional Codex count-quality evidence is unavailable; absence does not mean zero.';
  }
  const signals = fields.map(([label, value]) => `${label}: ${value === null ? 'unavailable' : value.toLocaleString()}`);
  return ` Count-quality diagnostics (file/event counts may overlap; not usage totals): ${signals.join('; ')}. Raw cumulative thread counters are diagnostic only.`;
}

/** Stored-history diagnostics plus an explicitly current queue observation; not a completeness audit. */
export function doctorSummary(report: DoctorReport): DoctorSummaryRow[] {
  const unreadable = sum(report.skippedPaths?.filter((row) => row.reason === 'unreadable').map((row) => row.count));
  const timingHistory = sum(report.skippedPaths?.filter((row) => row.reason === 'timestamp-unavailable').map((row) => row.count));
  const checkpointHistory = sum(report.skippedPaths?.filter((row) => row.reason === 'checkpoint-unverified').map((row) => row.count));
  const unpriced = sum(report.unmatchedModels?.map((row) => row.events));
  const capture = report.ollama?.capture;
  const unmatchedModels = unmatchedModelsRow(report.unmatchedModels);
  const ollamaServers = ollamaServerRows(report.ollama?.servers, report.generatedAt);
  return [
    {
      label: 'Unreadable paths', value: amount(unreadable, 'path reported', 'paths reported'),
      note: 'Stored collector diagnostics. Review Coverage for scan status and skipped-path reasons.',
    },
    {
      label: 'Codex baseline review', value: amount(count(report.codex?.suspectFiles), 'file flagged', 'files flagged'),
      note: 'Inherited counts need review. A flag alone does not establish missing or duplicated tokens.' + codexQualityNote(report.codex),
    },
    {
      label: 'Unpriced usage', value: amount(unpriced, 'event', 'events'),
      note: 'These recorded events have no dollar amount. API-equivalent dollars exclude them.',
    },
    {
      label: 'Local server capture',
      value: capture === 'off' ? 'Off' : capture === 'proxy' ? 'Proxy configured' : capture === 'serverlog' ? 'Server log configured' : capture === 'both' ? 'Proxy and server log configured' : 'Evidence unavailable',
      note: 'Configuration does not establish successful or complete capture. Review Coverage for evidence.',
    },
    {
      label: 'Proxy requests with incomplete metering',
      value: amount(count(report.ollama?.unmeteredRequests), 'request reported', 'requests reported'),
      note: 'Persisted across configured proxies; no selected-period filter. A request can retain partial token counts in the ledger, so do not add this counter to event totals. Zero does not establish complete capture.',
    },
    {
      label: 'Proxy capture backlog',
      value: amount(count(report.ollama?.backlog?.pending), 'request waiting', 'requests waiting'),
      note: report.ollama?.backlog ? queueNote(report.ollama.backlog)
        : 'Current queue evidence is unavailable on this runtime. Absence does not mean zero pending requests.',
    },
    {
      label: 'Stored price fields', value: priceFieldLabel(report) ?? 'No field conflicts recorded',
      note: priceFieldState(report) === 'checked' ? 'Whole stored history. Field consistency does not validate vendor rates or an invoice.' : 'Whole stored history. Missing checks are unknown; conflicting fields need review.',
    },
    {
      label: 'Timestamp hold history', value: amount(timingHistory, 'path reported', 'paths reported'),
      note: 'Stored paths where usage awaited a reliable timestamp. Paths may remain after recovery or a file move; this is not a current hold or missing-token total.',
    },
    {
      label: 'Checkpoint hold history', value: amount(checkpointHistory, 'hold recorded', 'holds recorded'),
      note: 'Recorded reads held because their consumed prefix could not be verified. History may remain after recovery; it does not show current pending capture or missing tokens. Review affected paths in Coverage.',
    },
    {
      label: 'Claude speed-assumed events',
      value: amount(count(report.claude?.speedAssumed), 'event', 'events'),
      note: 'Stored Claude events whose speed basis was assumed; this is an event diagnostic, not a token or dollar total.',
    },
    {
      label: 'Claude cache-split-assumed events',
      value: amount(count(report.claude?.cacheSplitAssumed), 'event', 'events'),
      note: 'Stored Claude events whose cache split was assumed; this is an event diagnostic, not a token or dollar total.',
    },
    { label: 'Unmatched model IDs', value: unmatchedModels.value, note: unmatchedModels.note },
    { label: 'Ollama server/log identity', value: ollamaServers.value, note: ollamaServers.note },
  ];
}
