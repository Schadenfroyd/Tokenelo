/**
 * src/tray/renderer/detail-history.ts — Back navigation for the session-detail window, driven
 * through the REAL, unchanged detail-load.ts loader with deferred fetches the test settles by hand.
 * The view is a recording double of the four calls detail.ts makes; detail.ts's DOM is not run.
 */
import { describe, expect, it } from 'vitest';
import type { SessionDetail, Source } from '../../src/tray/renderer/api-types.js';
import { createDetailLoader } from '../../src/tray/renderer/detail-load.js';
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  backIntent,
  childIntent,
  committed,
  createDetailNavigator,
  type DetailView,
} from '../../src/tray/renderer/detail-history.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function detail(source: Source, sessionId: string): SessionDetail {
  return { source, sessionId, project: `C:/work/${source}-${sessionId}` } as unknown as SessionDetail;
}

function setup() {
  const calls: { source: Source; sessionId: string; reply: Deferred<SessionDetail> }[] = [];
  const loader = createDetailLoader((source, sessionId) => {
    const reply = deferred<SessionDetail>();
    calls.push({ source, sessionId, reply });
    return reply.promise;
  });
  const log: string[] = [];
  const view = { body: '', back: false, ready: [] as string[] };
  const recorder: DetailView = {
    pending: (key, canGoBack) => {
      view.body = `loading ${key.source}/${key.sessionId}`;
      view.back = canGoBack;
      log.push(`pending ${key.source}/${key.sessionId}`);
    },
    success: (d) => {
      view.body = `shown ${d.source}/${d.sessionId}`;
    },
    failure: (err) => {
      view.body = `error ${(err as Error).message}`;
    },
    ready: (t) => view.ready.push(`${t.key.source}/${t.key.sessionId}`),
  };
  const nav = createDetailNavigator(loader, recorder);
  /** Settles call `i` with its own key and waits for the navigator's commit. */
  const ok = async (i: number, p: Promise<void>) => {
    calls[i]!.reply.resolve(detail(calls[i]!.source, calls[i]!.sessionId));
    await p;
  };
  const fail = async (i: number, p: Promise<void>) => {
    calls[i]!.reply.reject(new Error('HTTP 503'));
    await p;
  };
  const keys = () => nav.history.ancestors.map((k) => `${k.source}/${k.sessionId}`);
  return { calls, nav, view, log, ok, fail, keys };
}

describe('session-detail Back history', () => {
  it('A → B → C, then Back twice returns to B then A, each with one fetch and Back hidden at the root', async () => {
    const { calls, nav, view, ok, keys } = setup();
    await ok(0, nav.root('claude', 'A'));
    expect(view.back).toBe(false);
    await ok(1, nav.child('claude', 'B'));
    await ok(2, nav.child('claude', 'C'));
    expect(keys()).toEqual(['claude/A', 'claude/B']);
    expect(view.back).toBe(true);
    await ok(3, nav.back());
    expect(view.body).toBe('shown claude/B');
    await ok(4, nav.back());
    expect(view.body).toBe('shown claude/A');
    expect(view.back).toBe(false);
    await nav.back();
    expect(calls).toHaveLength(5);
  });

  it('a failed child keeps Back, and Back returns to the parent without retrying the child', async () => {
    const { calls, nav, view, ok, fail } = setup();
    await ok(0, nav.root('claude', 'A'));
    await fail(1, nav.child('claude', 'B'));
    expect(view.body).toBe('error HTTP 503');
    expect(view.back).toBe(true);
    expect(nav.history.shown?.sessionId).toBe('A');
    await ok(2, nav.back());
    expect(view.body).toBe('shown claude/A');
    expect(calls.map((c) => c.sessionId)).toEqual(['A', 'B', 'A']);
  });

  it('a failed Back leaves the next ancestor reachable', async () => {
    const { nav, view, ok, fail } = setup();
    await ok(0, nav.root('claude', 'A'));
    await ok(1, nav.child('claude', 'B'));
    await ok(2, nav.child('claude', 'C'));
    await fail(3, nav.back());
    expect(view.body).toBe('error HTTP 503');
    expect(view.back).toBe(true);
    await ok(4, nav.back());
    expect(view.body).toBe('shown claude/A');
  });

  it('a late child success after a newer sibling does not paint, ready, or become shown', async () => {
    const { calls, nav, view, ok, keys } = setup();
    await ok(0, nav.root('claude', 'A'));
    const child = nav.child('claude', 'B');
    const sibling = nav.child('claude', 'B2');
    await ok(2, sibling);
    await ok(1, child);
    expect(view.body).toBe('shown claude/B2');
    expect(view.ready).toEqual(['claude/A', 'claude/B2']);
    expect(nav.history.shown?.sessionId).toBe('B2');
    // The second activation while the first was pending added no ghost ancestor.
    expect(keys()).toEqual(['claude/A']);
    expect(calls).toHaveLength(3);
  });

  it('a late child error after Back does not replace the parent', async () => {
    const { nav, view, ok, fail } = setup();
    await ok(0, nav.root('claude', 'A'));
    const child = nav.child('claude', 'B');
    await ok(2, nav.back());
    await fail(1, child);
    expect(view.body).toBe('shown claude/A');
    expect(view.back).toBe(false);
  });

  it('rapid Back twice while pending lands on the oldest ancestor', async () => {
    const { nav, view, ok } = setup();
    await ok(0, nav.root('claude', 'A'));
    await ok(1, nav.child('claude', 'B'));
    await ok(2, nav.child('claude', 'C'));
    const first = nav.back();
    const second = nav.back();
    await ok(4, second);
    await ok(3, first);
    expect(view.body).toBe('shown claude/A');
    expect(view.ready.at(-1)).toBe('claude/A');
    expect(nav.history.ancestors).toHaveLength(0);
  });

  it('an external root during a pending child clears history and wins', async () => {
    const { nav, view, ok } = setup();
    await ok(0, nav.root('claude', 'A'));
    const child = nav.child('claude', 'B');
    const external = nav.root('codex', 'X');
    expect(view.back).toBe(false);
    await ok(2, external);
    await ok(1, child);
    expect(view.body).toBe('shown codex/X');
    expect(nav.history.ancestors).toHaveLength(0);
  });

  it('a pending root is never recorded as a parent', async () => {
    const { nav, keys, ok } = setup();
    const root = nav.root('claude', 'A');
    const child = nav.child('claude', 'B');
    expect(keys()).toEqual([]);
    await ok(1, child);
    await ok(0, root);
    expect(keys()).toEqual([]);
  });

  it('refreshing the shown key adds no ancestor', async () => {
    const { calls, nav, ok, keys } = setup();
    await ok(0, nav.root('claude', 'A'));
    await ok(1, nav.child('claude', 'A'));
    expect(keys()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('the same id under another source is a distinct ancestor', async () => {
    const { nav, ok, keys } = setup();
    await ok(0, nav.root('claude', 'shared'));
    await ok(1, nav.child('codex', 'shared'));
    expect(keys()).toEqual(['claude/shared']);
    await ok(2, nav.back());
    expect(nav.history.shown).toEqual({ source: 'claude', sessionId: 'shared' });
  });

  it('an empty boot key takes the loader error path with Back hidden', async () => {
    const { calls, nav, view } = setup();
    const boot = nav.root('claude', '');
    calls[0]!.reply.reject(new Error('session not found'));
    await boot;
    expect(view.body).toBe('error session not found');
    expect(view.back).toBe(false);
  });
});

describe('history values', () => {
  it('ancestors are capped at the limit, keeping the newest', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) {
      h = committed(childIntent(h, { source: 'claude', sessionId: `s${i}` }), { source: 'claude', sessionId: `s${i}` });
    }
    expect(h.ancestors).toHaveLength(HISTORY_LIMIT);
    expect(h.ancestors.at(-1)?.sessionId).toBe(`s${HISTORY_LIMIT + 6}`);
    expect(h.ancestors[0]?.sessionId).toBe('s7');
  });

  it('history holds frozen copies, not the caller’s objects', () => {
    const key = { source: 'claude' as Source, sessionId: 'A' };
    const h = childIntent(committed(EMPTY_HISTORY, key), { source: 'claude', sessionId: 'B' });
    key.sessionId = 'mutated';
    expect(h.ancestors[0]?.sessionId).toBe('A');
    expect(Object.isFrozen(h.ancestors)).toBe(true);
    expect(Object.isFrozen(h.ancestors[0])).toBe(true);
    expect(Object.isFrozen(h)).toBe(true);
    expect(backIntent(EMPTY_HISTORY)).toBeNull();
  });
});
