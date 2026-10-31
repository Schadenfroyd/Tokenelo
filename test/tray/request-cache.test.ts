/**
 * Per-key cache writes under controlled responses (src/tray/renderer/request-cache.ts). Each expected state is a literal.
 */
import { describe, expect, it } from 'vitest';
import { RequestCache } from '../../src/tray/renderer/request-cache.js';

/** A request the test resolves or rejects by hand. `fetches` counts how many were started. */
function controlled<T>() {
  const requests: Array<{ resolve(v: T): void; reject(e: Error): void }> = [];
  const fetch = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      requests.push({ resolve, reject });
    });
  return { requests, fetch };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

describe('a late earlier response cannot replace a newer cached value', () => {
  it('two loads of one key: the newer one fills the cache, and the earlier one arriving last changes nothing', async () => {
    const cache = new RequestCache<'doctor', string[]>();
    const { requests, fetch } = controlled<string[]>();
    const earlier = cache.load('doctor', fetch); // request 0: the bootstrap read, held
    const newer = cache.load('doctor', fetch); // request 1: the user's read
    requests[1]!.resolve(['CurrentFixtureWarning']);
    expect(await newer).toEqual(['CurrentFixtureWarning']);
    requests[0]!.resolve([]); // the earlier response arrives last
    expect(await earlier).toEqual([]); // its own caller still gets its own value
    expect(cache.get('doctor')).toEqual(['CurrentFixtureWarning']);
    // A reopen reads the cache: the newest report, with no new request.
    expect(await cache.load('doctor', fetch)).toEqual(['CurrentFixtureWarning']);
    expect(requests).toHaveLength(2);
  });

  it('the same outcome when the newer response arrives first and the earlier one arrives after it, for an earlier that finishes last', async () => {
    const cache = new RequestCache<'summary', string>();
    const { requests, fetch } = controlled<string>();
    const first = cache.load('summary', fetch);
    const second = cache.load('summary', fetch);
    requests[1]!.resolve('second');
    await second;
    requests[0]!.resolve('first');
    await first;
    await flush();
    expect(cache.get('summary')).toBe('second');
  });
});

describe('a Refresh (clear) retires loads still in flight', () => {
  it('a load started before a clear cannot repopulate the cache, and the next read fetches again', async () => {
    const cache = new RequestCache<'doctor', string>();
    const { requests, fetch } = controlled<string>();
    const before = cache.load('doctor', fetch); // request 0, held across the Refresh
    cache.clear();
    requests[0]!.resolve('from before the refresh');
    expect(await before).toBe('from before the refresh');
    expect(cache.get('doctor')).toBeUndefined();

    const after = cache.load('doctor', fetch); // request 1
    requests[1]!.resolve('after the refresh');
    expect(await after).toBe('after the refresh');
    expect(cache.get('doctor')).toBe('after the refresh');
    expect(requests).toHaveLength(2);
  });
});

describe('failures and hits', () => {
  it('when the newest load fails, the key stays empty, and an older success does not fill it', async () => {
    const cache = new RequestCache<'coverage', string>();
    const { requests, fetch } = controlled<string>();
    const older = cache.load('coverage', fetch); // request 0
    const newer = cache.load('coverage', fetch); // request 1, the newest
    requests[1]!.reject(new Error('timeout'));
    await expect(newer).rejects.toThrow('timeout');
    requests[0]!.resolve('older success');
    expect(await older).toBe('older success');
    expect(cache.get('coverage')).toBeUndefined();
  });

  it('a cached value is returned without a request', async () => {
    const cache = new RequestCache<'limits', string>();
    const { requests, fetch } = controlled<string>();
    const first = cache.load('limits', fetch);
    requests[0]!.resolve('snapshots');
    await first;
    expect(await cache.load('limits', fetch)).toBe('snapshots');
    expect(requests).toHaveLength(1);
  });

  it('keys are independent: a late response for one range does not touch another range', async () => {
    const cache = new RequestCache<string, string>();
    const { requests, fetch } = controlled<string>();
    const seven = cache.load('7d', fetch);
    const thirty = cache.load('30d', fetch);
    requests[1]!.resolve('thirty-day totals');
    await thirty;
    requests[0]!.resolve('seven-day totals');
    await seven;
    expect(cache.get('30d')).toBe('thirty-day totals');
    expect(cache.get('7d')).toBe('seven-day totals');
  });
});
