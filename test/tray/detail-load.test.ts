/**
 * src/tray/renderer/detail-load.ts — which load intent may change the session-detail window when
 * responses arrive out of order. Fetches are deferred promises the test settles by hand. Parent,
 * child and sibling payloads differ in project, models and dollars, so a wrong commit shows in the
 * assertions. The window is a plain double here: detail.ts and its DOM are not run.
 */
import { describe, expect, it } from 'vitest';
import type { SessionDetail, Source } from '../../src/tray/renderer/api-types.js';
import { DETAIL_IDENTITY_MISMATCH, createDetailLoader, type DetailLoader } from '../../src/tray/renderer/detail-load.js';

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

function detail(source: Source, sessionId: string, project: string, models: string[], usd: number): SessionDetail {
  return { source, sessionId, project, models, apiEquivUsd: usd } as unknown as SessionDetail;
}

const PARENT = detail('claude', 'parent-1', 'C:/work/parent-app', ['claude-opus-5-5'], 41.5);
const CHILD = detail('claude', 'child-7', 'C:/work/parent-app/agents', ['claude-haiku-4-5-20251001'], 0.82);
const SIBLING = detail('claude', 'child-8', 'C:/work/parent-app/review', ['claude-sonnet-5'], 3.1);

/** A fetch whose every call is recorded and waits for the test to settle it. */
function fetchDouble() {
  const calls: { source: Source; sessionId: string; reply: Deferred<SessionDetail> }[] = [];
  const fetch = (source: Source, sessionId: string): Promise<SessionDetail> => {
    const reply = deferred<SessionDetail>();
    calls.push({ source, sessionId, reply });
    return reply.promise;
  };
  return { calls, fetch };
}

/** What the window would show, driven the way detail.ts drives it: begin, await, then commit. */
function windowDouble(loader: DetailLoader) {
  const view = { body: 'Loading…', title: '', ready: [] as string[] };
  const load = async (source: Source, sessionId: string): Promise<void> => {
    view.body = 'Loading…';
    const { outcome } = loader.begin(source, sessionId);
    loader.commit(await outcome, {
      success: (d) => {
        view.body = `${d.project} · ${d.models.join(', ')} · $${d.apiEquivUsd}`;
        view.title = String(d.project);
      },
      failure: (err) => {
        view.body = `Could not load session: ${err instanceof Error ? err.message : String(err)}`;
      },
      ready: (ticket) => view.ready.push(ticket.key.sessionId),
    });
  };
  return { view, load };
}

function setup() {
  const f = fetchDouble();
  const loader = createDetailLoader(f.fetch);
  return { ...f, loader, ...windowDouble(loader) };
}

describe('only the newest load intent changes the window', () => {
  it('a child opened from its parent wins even when the parent answers last', async () => {
    const { calls, view, load } = setup();
    const parent = load('claude', 'parent-1');
    const child = load('claude', 'child-7');
    calls[1]!.reply.resolve(CHILD);
    await child;
    calls[0]!.reply.resolve(PARENT);
    await parent;
    expect(view.body).toBe('C:/work/parent-app/agents · claude-haiku-4-5-20251001 · $0.82');
    expect(view.title).toBe('C:/work/parent-app/agents');
    expect(view.ready).toEqual(['child-7']);
  });

  it('a stale parent rejecting after the child succeeded does not show its error', async () => {
    const { calls, view, load } = setup();
    const parent = load('claude', 'parent-1');
    const child = load('claude', 'child-7');
    calls[1]!.reply.resolve(CHILD);
    await child;
    calls[0]!.reply.reject(new Error('HTTP 503'));
    await parent;
    expect(view.body).toContain('$0.82');
    expect(view.ready).toEqual(['child-7']);
  });

  it('the newest intent failing after an older success shows the error, keeps the older result out, and is not ready', async () => {
    const { calls, view, load } = setup();
    const child = load('claude', 'child-7');
    const sibling = load('claude', 'child-8');
    calls[0]!.reply.resolve(CHILD);
    await child;
    expect(view.body).toBe('Loading…');
    calls[1]!.reply.reject(new Error('HTTP 503'));
    await sibling;
    expect(view.body).toBe('Could not load session: HTTP 503');
    expect(view.ready).toEqual([]);
  });

  it('the same sessionId under another source is a different intent', async () => {
    const { calls, view, load } = setup();
    const claude = load('claude', 'shared-id');
    const codex = load('codex', 'shared-id');
    calls[1]!.reply.resolve(detail('codex', 'shared-id', 'C:/work/codex-side', ['gpt-5'], 7));
    await codex;
    calls[0]!.reply.resolve(detail('claude', 'shared-id', 'C:/work/claude-side', ['claude-opus-5-5'], 9));
    await claude;
    expect(view.body).toBe('C:/work/codex-side · gpt-5 · $7');
  });

  it('requesting the same key again supersedes the earlier request for it', async () => {
    const { calls, view, load } = setup();
    const first = load('claude', 'parent-1');
    const again = load('claude', 'parent-1');
    calls[1]!.reply.resolve(detail('claude', 'parent-1', 'C:/work/parent-app', ['claude-opus-5-5'], 42));
    await again;
    calls[0]!.reply.resolve(detail('claude', 'parent-1', 'C:/work/parent-app', ['claude-opus-5-5'], 40));
    await first;
    expect(view.body).toContain('$42');
    expect(view.ready).toEqual(['parent-1']);
  });

  it('each intent makes exactly one fetch with its own key, and a failure is not retried', async () => {
    const { calls, load } = setup();
    const a = load('claude', 'parent-1');
    const b = load('codex', 'child-7');
    calls[0]!.reply.reject(new Error('HTTP 503'));
    calls[1]!.reply.reject(new Error('HTTP 503'));
    await Promise.all([a, b]);
    await Promise.resolve();
    expect(calls.map(({ source, sessionId }) => ({ source, sessionId }))).toEqual([
      { source: 'claude', sessionId: 'parent-1' },
      { source: 'codex', sessionId: 'child-7' },
    ]);
  });

  it('a response for another session is shown as a fixed error, not drawn', async () => {
    const { calls, view, load } = setup();
    const child = load('claude', 'child-7');
    calls[0]!.reply.resolve(SIBLING);
    await child;
    expect(view.body).toBe(`Could not load session: ${DETAIL_IDENTITY_MISMATCH}`);
    expect(view.body).not.toContain('child-8');
    expect(view.ready).toEqual([]);
  });

  const { source: _s, sessionId: _id, ...NO_IDENTITY } = CHILD as unknown as Record<string, unknown>;
  const malformed: [string, unknown][] = [
    ['null', null],
    ['a non-object', 'child-7'],
    ['no identity fields', NO_IDENTITY],
    ['no source', { ...NO_IDENTITY, sessionId: 'child-7' }],
    ['no sessionId', { ...NO_IDENTITY, source: 'claude' }],
    ['a null source', { ...NO_IDENTITY, source: null, sessionId: 'child-7' }],
    ['a numeric sessionId', { ...NO_IDENTITY, source: 'claude', sessionId: 7 }],
    ['the right sessionId under another source', { ...NO_IDENTITY, source: 'codex', sessionId: 'child-7' }],
  ];
  for (const [label, reply] of malformed) {
    it(`a response with ${label} is refused with the fixed error and never drawn`, async () => {
      const { calls, view, load } = setup();
      const child = load('claude', 'child-7');
      calls[0]!.reply.resolve(reply as SessionDetail);
      await child;
      expect(view.body).toBe(`Could not load session: ${DETAIL_IDENTITY_MISMATCH}`);
      expect(view.body).not.toContain('$0.82');
      expect(view.title).toBe('');
      expect(view.ready).toEqual([]);
      expect(calls).toHaveLength(1);
    });
  }

  it('a fetch that throws synchronously becomes that intent’s error, not an unhandled throw', async () => {
    const loader = createDetailLoader(() => {
      throw new Error('bridge unavailable');
    });
    const { view, load } = windowDouble(loader);
    await expect(load('claude', 'parent-1')).resolves.toBeUndefined();
    expect(view.body).toBe('Could not load session: bridge unavailable');
    expect(view.ready).toEqual([]);
  });

  it('a new intent between classification and the UI commit stops the older result from committing', async () => {
    const { calls, loader } = setup();
    const committed: string[] = [];
    const handlers = {
      success: (d: SessionDetail) => committed.push(`success ${d.sessionId}`),
      failure: () => committed.push('failure'),
      ready: () => committed.push('ready'),
    };
    const { outcome } = loader.begin('claude', 'parent-1');
    calls[0]!.reply.resolve(PARENT);
    const classified = await outcome;
    expect(classified.kind).toBe('current');
    // The user opens a subagent while the parent's continuation is still queued.
    loader.begin('claude', 'child-7');
    expect(loader.commit(classified, handlers)).toBe(false);
    expect(committed).toEqual([]);
  });

  it('a new intent started while a success is painting withholds that success’s ready', async () => {
    const { calls, loader } = setup();
    const ready: string[] = [];
    const { outcome } = loader.begin('claude', 'parent-1');
    calls[0]!.reply.resolve(PARENT);
    loader.commit(await outcome, {
      success: () => void loader.begin('claude', 'child-7'),
      failure: () => undefined,
      ready: (t) => ready.push(t.key.sessionId),
    });
    expect(ready).toEqual([]);
  });

  it('boot, then a load from the popover, then a subagent: only the last is ready', async () => {
    const { calls, view, load } = setup();
    const boot = load('claude', 'parent-1');
    const fromPopover = load('claude', 'child-8');
    const subagent = load('claude', 'child-7');
    calls[1]!.reply.resolve(SIBLING);
    calls[0]!.reply.resolve(PARENT);
    await Promise.all([boot, fromPopover]);
    expect(view.ready).toEqual([]);
    calls[2]!.reply.resolve(CHILD);
    await subagent;
    expect(view.ready).toEqual(['child-7']);
    expect(view.body).toContain('claude-haiku-4-5-20251001');
  });
});
