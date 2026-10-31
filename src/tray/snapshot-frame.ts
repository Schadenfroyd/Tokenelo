/** A fresh offscreen paint after renderer readiness, without showing a native window.
 * The caller supplies Electron's paint subscription and invalidate operation; tests need no Electron runtime.
 * The deadline is an engineering bound, not a measured compositor service level. */
export interface SnapshotPaintSource<Image> {
  subscribePaint(listener: (image: Image) => void): () => void;
  invalidate(): void;
}

export function nextSnapshotPaint<Image>(source: SnapshotPaintSource<Image>, deadlineMs = 5_000): Promise<Image> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    return Promise.reject(new Error('invalid snapshot paint deadline'));
  }
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = (image?: Image, failure?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (failure) reject(failure);
      else resolve(image as Image);
    };
    const timer = setTimeout(() => finish(undefined, new Error('snapshot paint deadline exceeded')), deadlineMs);
    try {
      unsubscribe = source.subscribePaint((image) => finish(image));
      if (settled) unsubscribe();
      else source.invalidate();
    } catch {
      finish(undefined, new Error('snapshot paint could not be requested'));
    }
  });
}
