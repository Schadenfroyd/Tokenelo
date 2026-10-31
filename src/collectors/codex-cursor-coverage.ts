/** Aggregate scan-time Codex byte cursor observations without exposing local paths. */
export interface CodexCursorCoverageAtStat {
  filesDiscovered: number;
  filesObservedAtStat: number;
  filesBehindCursorAtStat: number;
  bytesUnreadAtStat: number;
  filesWithoutUsableCursorAtStat: number;
  filesWithStatError: number;
  filesWithCursorStateError: number;
}

export function emptyCodexCursorCoverageAtStat(): CodexCursorCoverageAtStat {
  return {
    filesDiscovered: 0,
    filesObservedAtStat: 0,
    filesBehindCursorAtStat: 0,
    bytesUnreadAtStat: 0,
    filesWithoutUsableCursorAtStat: 0,
    filesWithStatError: 0,
    filesWithCursorStateError: 0,
  };
}

/** Record a stat-bound remainder. Unknown/unusable cursors start at byte zero and are
 * reported separately; a stat error never gets converted into a zero-byte result. */
export function recordCodexCursorAtStat(
  summary: CodexCursorCoverageAtStat,
  fileSize: number | null,
  nextOffset: number | null,
  cursorStateRead: 'ok' | 'failed' = 'ok',
): void {
  if (fileSize === null || !Number.isSafeInteger(fileSize) || fileSize < 0) {
    summary.filesWithStatError++;
    return;
  }
  summary.filesObservedAtStat++;
  if (cursorStateRead === 'failed') summary.filesWithCursorStateError++;
  const usableCursor = cursorStateRead === 'ok'
    && nextOffset !== null
    && Number.isSafeInteger(nextOffset)
    && nextOffset >= 0
    && nextOffset <= fileSize;
  if (!usableCursor) summary.filesWithoutUsableCursorAtStat++;
  const unread = fileSize - (usableCursor ? nextOffset : 0);
  if (unread > 0) summary.filesBehindCursorAtStat++;
  summary.bytesUnreadAtStat += unread;
}
