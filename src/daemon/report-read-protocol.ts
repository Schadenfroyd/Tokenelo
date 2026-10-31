import type { PriceRow, Range, Source, TokeneloConfig,
  SummaryResponse, SessionsResponse, TimeseriesResponse, SessionDetail, DoctorReport } from '../core/types.js';
import type { SessionsOpts } from '../store/queries.js';
import type { BuildIdentity } from './build-identity.js';

/** Only daemon-owned inputs cross this boundary; no public path/module/function arguments. */
export interface ReportReadConfiguration {
  dbFile: string;
  /** The daemon's one startup identity; null keeps source-development reads explicitly unknown. */
  buildIdentity?: BuildIdentity | null;
  config: TokeneloConfig;
  priceRows: PriceRow[];
  pricesVersion: string;
}
export type ReportTask =
  | { kind: 'summary'; range: Range }
  | { kind: 'usage'; range: Range }
  | { kind: 'sessions'; opts: SessionsOpts }
  | { kind: 'timeseries'; bucket: 'hour' | 'day'; range: Range }
  | { kind: 'doctor' }
  | { kind: 'detail'; source: Source; sessionId: string };
export interface ReportResults {
  summary: SummaryResponse;
  usage: import('../core/types.js').UsageResponse;
  sessions: SessionsResponse;
  timeseries: TimeseriesResponse;
  doctor: DoctorReport;
  detail: SessionDetail | null;
}
export type ReportReadErrorCode = 'read_capacity' | 'read_timeout' | 'read_cancelled' |
  'read_unavailable' | 'query_failed' | 'result_too_large';
export class ReportReadError extends Error {
  constructor(readonly code: ReportReadErrorCode) {
    super({ read_capacity: 'A report is already using the available read capacity. Try again shortly.',
      read_timeout: 'The report exceeded its read budget. Try a shorter period.',
      read_cancelled: 'The report read was cancelled.',
      read_unavailable: 'Report reads are temporarily unavailable.',
      query_failed: 'The report could not be read.',
      result_too_large: 'The report is too large to return. Try a shorter period.' }[code]);
    this.name = 'ReportReadError';
  }
}
