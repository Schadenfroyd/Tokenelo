/**
 * src/tray/renderer/detail-ready.ts — ready needs the newest detail success AND the applied initial
 * theme, driven through the REAL detail-load.ts loader and detail-history.ts navigator with
 * deferred fetches and a deferred theme. Not a DOM, screen or native test.
 */
import { describe, expect, it } from 'vitest';
import type { SessionDetail, Source } from '../../src/tray/renderer/api-types.js';
import { createDetailLoader } from '../../src/tray/renderer/detail-load.js';
import { createDetailNavigator } from '../../src/tray/renderer/detail-history.js';
import { createReadyGate } from '../../src/tray/renderer/detail-ready.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup() {
  const replies: { source: Source; sessionId: string; reply: ReturnType<typeof deferred<SessionDetail>> }[] = [];
  const loader = createDetailLoader((source, sessionId) => {
    const reply = deferred<SessionDetail>();
    replies.push({ source, sessionId, reply });
    return reply.promise;
  });
  const theme = deferred<void>();
  // A real rejection handler is attached by the gate; this only keeps an unawaited rejection quiet.
  theme.promise.catch(() => undefined);
  const ready: string[] = [];
  const gate = createReadyGate(theme.promise, loader.isCurrent, (t) => ready.push(`${t.key.source}/${t.key.sessionId}`));
  const nav = createDetailNavigator(loader, {
    pending: () => undefined,
    success: () => undefined,
    failure: () => undefined,
    ready: (t) => void gate(t),
  });
  const ok = (i: number) => replies[i]!.reply.resolve({ source: replies[i]!.source, sessionId: replies[i]!.sessionId } as unknown as SessionDetail);
  return { nav, theme, ready, ok, replies };
}

describe('detail readiness gate', () => {
  it('a fast detail success waits for a slow theme', async () => {
    const { nav, theme, ready, ok } = setup();
    const boot = nav.root('claude', 'A');
    ok(0);
    await boot;
    await flush();
    expect(ready).toEqual([]);
    theme.resolve();
    await flush();
    expect(ready).toEqual(['claude/A']);
  });

  it('a success superseded during the theme await never signals; the newest one does', async () => {
    const { nav, theme, ready, ok } = setup();
    const boot = nav.root('claude', 'A');
    ok(0);
    await boot;
    const external = nav.root('codex', 'X');
    theme.resolve();
    await flush();
    expect(ready).toEqual([]);
    ok(1);
    await external;
    await flush();
    expect(ready).toEqual(['codex/X']);
  });

  it('a newest failure never signals, even after the theme applies', async () => {
    const { nav, theme, ready, ok, replies } = setup();
    const boot = nav.root('claude', 'A');
    ok(0);
    await boot;
    const child = nav.child('claude', 'B');
    replies[1]!.reply.reject(new Error('HTTP 503'));
    await child;
    theme.resolve();
    await flush();
    expect(ready).toEqual([]);
  });

  it('a rejected theme read never signals ready', async () => {
    const { nav, theme, ready, ok } = setup();
    const boot = nav.root('claude', 'A');
    ok(0);
    await boot;
    theme.reject(new Error('theme unavailable'));
    await flush();
    expect(ready).toEqual([]);
  });

  it('with the theme already applied, a current success signals once', async () => {
    const { nav, theme, ready, ok } = setup();
    theme.resolve();
    const boot = nav.root('claude', 'A');
    ok(0);
    await boot;
    await flush();
    expect(ready).toEqual(['claude/A']);
  });
});
