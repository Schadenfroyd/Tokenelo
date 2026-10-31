import { describe, expect, it } from 'vitest';
import {
  emptyCodexCursorCoverageAtStat,
  recordCodexCursorAtStat,
} from '../../src/collectors/codex-cursor-coverage.js';

describe('Codex per-file cursor observations', () => {
  it('reports unread source bytes at the file stat, separately from new event counts', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    coverage.filesDiscovered++;
    recordCodexCursorAtStat(coverage, 100, 72);
    expect(coverage).toMatchObject({
      filesObservedAtStat: 1,
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: 28,
      filesWithoutUsableCursorAtStat: 0,
    });
  });

  it('does not invent a backlog when the stored cursor matches the observed size', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    recordCodexCursorAtStat(coverage, 80, 80);
    expect(coverage.filesBehindCursorAtStat).toBe(0);
    expect(coverage.bytesUnreadAtStat).toBe(0);
  });

  it('counts the observed file from byte zero when no trusted cursor exists', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    recordCodexCursorAtStat(coverage, 81, null);
    expect(coverage).toMatchObject({
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: 81,
      filesWithoutUsableCursorAtStat: 1,
    });
  });

  it('treats an invalid past-end cursor as unusable instead of a negative backlog', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    recordCodexCursorAtStat(coverage, 81, 82);
    expect(coverage).toMatchObject({
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: 81,
      filesWithoutUsableCursorAtStat: 1,
    });
  });

  it('separates cursor state read failure from missing state', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    recordCodexCursorAtStat(coverage, 81, null, 'failed');
    expect(coverage).toMatchObject({
      filesWithCursorStateError: 1,
      filesWithoutUsableCursorAtStat: 1,
      bytesUnreadAtStat: 81,
    });
  });

  it('does not turn a stat failure into an empty file', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    recordCodexCursorAtStat(coverage, null, null);
    expect(coverage).toMatchObject({
      filesObservedAtStat: 0,
      filesWithStatError: 1,
      bytesUnreadAtStat: 0,
    });
  });

  it('aggregates file observations without merging errors into zero', () => {
    const coverage = emptyCodexCursorCoverageAtStat();
    coverage.filesDiscovered = 3;
    recordCodexCursorAtStat(coverage, 100, 100);
    recordCodexCursorAtStat(coverage, 51, 30);
    recordCodexCursorAtStat(coverage, null, null);
    expect(coverage).toMatchObject({
      filesDiscovered: 3,
      filesObservedAtStat: 2,
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: 21,
      filesWithStatError: 1,
    });
  });
});
