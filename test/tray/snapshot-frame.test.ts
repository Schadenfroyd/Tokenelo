import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextSnapshotPaint, type SnapshotPaintSource } from '../../src/tray/snapshot-frame.js';

afterEach(() => vi.useRealTimers());

function paintSource() {
  let listener: ((image: string) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const invalidate = vi.fn();
  const source: SnapshotPaintSource<string> = {
    subscribePaint: vi.fn((next) => { listener = next; return unsubscribe; }),
    invalidate,
  };
  return { source, unsubscribe, invalidate, paint: (image: string) => listener?.(image) };
}

describe('fresh hidden snapshot paint', () => {
  it('subscribes before invalidation and accepts a synchronous fresh frame', async () => {
    const s = paintSource();
    s.invalidate.mockImplementation(() => s.paint('fresh'));
    expect(await nextSnapshotPaint(s.source)).toBe('fresh');
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });
  it('waits for paint and removes its subscription after the first frame', async () => {
    const s = paintSource();
    const result = nextSnapshotPaint(s.source);
    s.paint('first');
    s.paint('second');
    expect(await result).toBe('first');
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });
  it('bounds a missing paint and removes the listener', async () => {
    vi.useFakeTimers();
    const s = paintSource();
    const result = nextSnapshotPaint(s.source, 10);
    const failure = expect(result).rejects.toThrow('snapshot paint deadline exceeded');
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });
  it('cleans up when invalidation throws, without exposing the raw error', async () => {
    const s = paintSource();
    s.invalidate.mockImplementation(() => { throw new Error('private-path'); });
    await expect(nextSnapshotPaint(s.source)).rejects.toThrow(/^snapshot paint could not be requested$/);
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });
  it('refuses invalid bounds before subscribing', async () => {
    const s = paintSource();
    for (const deadline of [0, -1, NaN, Infinity, 1.5]) {
      await expect(nextSnapshotPaint(s.source, deadline)).rejects.toThrow('invalid snapshot paint deadline');
    }
    expect(s.source.subscribePaint).not.toHaveBeenCalled();
    expect(s.invalidate).not.toHaveBeenCalled();
  });
  it('clears the deadline when subscription fails', async () => {
    vi.useFakeTimers();
    const s = paintSource();
    vi.mocked(s.source.subscribePaint).mockImplementation(() => { throw new Error('private-path'); });
    await expect(nextSnapshotPaint(s.source)).rejects.toThrow(/^snapshot paint could not be requested$/);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.invalidate).not.toHaveBeenCalled();
  });
});
