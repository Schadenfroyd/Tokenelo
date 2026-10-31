/** Cooperative control for read-only reports. Phases describe work, not a completion percentage. */
/** Progress phase of a daemon report read job. Names the work being done, never a completion percentage. */
export type ReadProgressPhase = 'reading-usage' | 'reading-activity' | 'building-sessions';
/** Private diagnostic labels; never carry session, path, model or report contents. */
export const DETAIL_READ_PHASES = ['detail-own-events', 'detail-descendants', 'detail-activity',
  'detail-aggregation', 'detail-response'] as const;
export type DetailReadPhase = typeof DETAIL_READ_PHASES[number];
export const DOCTOR_READ_PHASES = [
  'doctor.event-census',
  'doctor.event-census.money-sum',
  'doctor.event-census.row-batches',
  'doctor.skipped-paths',
  'doctor.unmatched-models',
  'doctor.codex-cursor-summaries',
  'doctor.ollama-probe',
  'doctor.unmetered-metadata',
  'doctor.acl-metadata',
  'doctor.response',
] as const;
export type DoctorReadPhase = typeof DOCTOR_READ_PHASES[number];
export const SESSION_READ_PHASES = ['sessions.events', 'sessions.ancestry', 'sessions.event-payload', 'sessions.activity', 'sessions.aggregation', 'sessions.response'] as const;
export type SessionReadPhase = typeof SESSION_READ_PHASES[number];
export const SUMMARY_READ_PHASES = ['summary.usage', 'summary.local', 'summary.subscriptions', 'summary.activity',
  'summary.active-time', 'summary.wall-time', 'summary.response'] as const;
export type SummaryReadPhase = typeof SUMMARY_READ_PHASES[number];
export const TIMESERIES_READ_PHASES = ['timeseries.sql', 'timeseries.map', 'timeseries.bucket', 'timeseries.response'] as const;
export type TimeseriesReadPhase = typeof TIMESERIES_READ_PHASES[number];
export type DiagnosticReadPhase = DetailReadPhase | DoctorReadPhase | SessionReadPhase | SummaryReadPhase | TimeseriesReadPhase;
export interface ReadControl {
  signal?: AbortSignal;
  onProgress?: (phase: ReadProgressPhase) => void;
  onDiagnosticPhase?: (phase: DiagnosticReadPhase) => void;
}
export function checkRead(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('read_cancelled');
}
export function readPhase(control: ReadControl | undefined, phase: ReadProgressPhase): void {
  checkRead(control?.signal);
  control?.onProgress?.(phase);
}
export function detailReadPhase(control: ReadControl | undefined, phase: DetailReadPhase): void {
  checkRead(control?.signal);
  control?.onDiagnosticPhase?.(phase);
}
export function doctorReadPhase(control: ReadControl | undefined, phase: DoctorReadPhase): void {
  checkRead(control?.signal);
  control?.onDiagnosticPhase?.(phase);
}
export function sessionReadPhase(control: ReadControl | undefined, phase: SessionReadPhase): void {
  checkRead(control?.signal);
  control?.onDiagnosticPhase?.(phase);
}

/** Static content-free Summary phase; duration and completion percentage are not implied. */
export function summaryReadPhase(control: ReadControl | undefined, phase: SummaryReadPhase): void {
  checkRead(control?.signal);
  control?.onDiagnosticPhase?.(phase);
}

/** Static chart phase entries; no content, row data, completion percentage or CPU attribution. */
export function timeseriesReadPhase(control: ReadControl | undefined, phase: TimeseriesReadPhase): void {
  checkRead(control?.signal);
  control?.onDiagnosticPhase?.(phase);
}
