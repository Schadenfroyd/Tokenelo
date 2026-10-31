import type { IncompleteCaptureStatus } from './api-types.js';

export interface ClaudeCaptureHoldViewBase {
  storedComponentEvidenceHeldFiles: number | null;
  oldestHeldAt: number | null;
  maxLineBytes: number | null;
  detail: string;
}

export type ClaudeCaptureHoldView =
  | (ClaudeCaptureHoldViewBase & {
    state: 'unavailable';
    label: 'Hold status unavailable';
    tone: 'neutral';
    heldFiles: null;
  })
  | (ClaudeCaptureHoldViewBase & {
    state: 'clear';
    label: 'No holds';
    tone: 'neutral';
    heldFiles: 0;
  })
  | (ClaudeCaptureHoldViewBase & {
    state: 'incomplete';
    label: 'Incomplete';
    tone: 'warn';
    heldFiles: number;
  });

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeLineCap(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Missing aggregate/Claude entry is unavailable; only an explicit zero means no recorded holds. */
export function claudeCaptureHoldView(
  incompleteCapture?: readonly IncompleteCaptureStatus[],
): ClaudeCaptureHoldView {
  const capture = incompleteCapture?.find((entry) => entry.collector === 'claude');
  const heldFiles = safeCount(capture?.heldFiles);
  if (!capture || heldFiles === null) {
    return {
      state: 'unavailable', label: 'Hold status unavailable', tone: 'neutral',
      heldFiles: null, storedComponentEvidenceHeldFiles: null, oldestHeldAt: null, maxLineBytes: null,
      detail: 'Claude hold status is unavailable from this daemon.',
    };
  }
  const rawStored = safeCount(capture.storedComponentEvidenceHeldFiles);
  const storedComponentEvidenceHeldFiles = rawStored !== null && rawStored <= heldFiles ? rawStored : null;
  const oldestHeldAt = safeTime(capture.oldestHeldAt);
  const maxLineBytes = safeLineCap(capture.maxLineBytes);
  if (heldFiles === 0) {
    return {
      state: 'clear', label: 'No holds', tone: 'neutral',
      heldFiles, storedComponentEvidenceHeldFiles, oldestHeldAt, maxLineBytes,
      detail: 'No held files recorded. Review scan results for current collection health.',
    };
  }
  const noun = heldFiles === 1 ? 'file' : 'files';
  const detail = storedComponentEvidenceHeldFiles === null
    ? `Usage capture is incomplete: the hold subtype is unavailable; ${heldFiles} held Claude ${noun} remain unresolved.`
    : storedComponentEvidenceHeldFiles === 0
      ? `Usage capture is incomplete: ${heldFiles} held Claude ${noun}; the held line and later records remain unread.`
      : storedComponentEvidenceHeldFiles === heldFiles
        ? `Usage capture is incomplete: ${heldFiles} held Claude ${noun}; batches and later records remain uncommitted.`
        : `Usage capture is incomplete: ${heldFiles} held Claude ${noun}; some lines remain unread and some batches remain uncommitted.`;
  return {
    state: 'incomplete', label: 'Incomplete', tone: 'warn',
    heldFiles, storedComponentEvidenceHeldFiles, oldestHeldAt, maxLineBytes, detail,
  };
}
