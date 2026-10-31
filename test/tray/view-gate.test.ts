/**
 * The popover's async-render coherence (src/tray/renderer/view-gate.ts). Responses are controlled here, so the order of
 * arrival is explicit. Each expected final state is written as a literal, not derived from the gate, so the gate cannot pass
 * by agreeing with itself.
 */
import { describe, expect, it } from 'vitest';
import { ViewGate, type View, type ViewKey } from '../../src/tray/renderer/view-gate.js';

interface Key extends ViewKey {
  tab: 'sessions' | 'usage' | 'local' | 'limits';
  range: '7d' | '30d' | 'today';
}

/** A fake panel: `body` is what the user sees, `busy` is aria-busy. */
function fakePanel() {
  const panel = { body: [] as string[], busy: false, ready: false, readySignals: 0 };
  const gate = new ViewGate<string[], Key>({
    createStage: () => [],
    commit: (stage) => {
      panel.body = [...stage];
    },
    clear: () => {
      panel.body = ['Loading…'];
    },
    setBusy: (busy) => {
      panel.busy = busy;
    },
    setReady: (ready) => {
      panel.ready = ready;
      if (ready) panel.readySignals++;
    },
  });
  return { panel, gate };
}

/** A response the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A renderer in the shape app.ts uses: it reads the range from the view, not from mutable state, and checks after each await. */
async function renderLabelled(view: View<string[], Key>, data: Promise<string>): Promise<void> {
  const value = await data;
  if (!view.current()) return;
  view.stage.push(`${view.key.tab} · ${view.key.range}`, value);
}

describe('late success across tabs', () => {
  it('an earlier tab response that lands last does not replace the tab now selected', async () => {
    const { panel, gate } = fakePanel();
    const sessions = deferred<string>();
    const limits = deferred<string>();

    const first = gate.begin({ tab: 'sessions', range: 'today' });
    const firstDone = renderLabelled(first, sessions.promise).then(() => gate.finish(first));
    const second = gate.begin({ tab: 'limits', range: 'today' });
    const secondDone = renderLabelled(second, limits.promise).then(() => gate.finish(second));

    limits.resolve('limit rows');
    await secondDone;
    sessions.resolve('session rows'); // arrives last, from the earlier selection
    await firstDone;
    await flush();

    expect(panel.body).toEqual(['limits · today', 'limit rows']);
    expect(panel.busy).toBe(false);
  });

  it('an earlier response that lands after the newer one leaves the newer body and clears busy only once', async () => {
    const { panel, gate } = fakePanel();
    const sessions = deferred<string>();
    const local = deferred<string>();

    const first = gate.begin({ tab: 'sessions', range: '7d' });
    const firstDone = renderLabelled(first, sessions.promise).then(() => gate.finish(first));
    const second = gate.begin({ tab: 'local', range: '7d' });
    const secondDone = renderLabelled(second, local.promise).then(() => gate.finish(second));

    expect(panel.busy).toBe(true); // both loading
    sessions.resolve('session rows');
    await firstDone;
    expect(panel.body).toEqual(['Loading…']); // the stale success committed nothing
    expect(panel.busy).toBe(true); // and did not clear the newer render's busy state
    expect(panel.ready).toBe(false); // the initial await completing cannot certify the newer view
    expect(panel.readySignals).toBe(0);

    local.resolve('local models');
    await secondDone;
    expect(panel.body).toEqual(['local · 7d', 'local models']);
    expect(panel.busy).toBe(false);
    expect(panel.ready).toBe(true);
    expect(panel.readySignals).toBe(1);
  });
});

describe('same-tab range change: label and data come from the same request', () => {
  it('a 7d response that lands after the 30d selection does not relabel the body', async () => {
    const { panel, gate } = fakePanel();
    const old = deferred<string>();
    const current = deferred<string>();

    const seven = gate.begin({ tab: 'usage', range: '7d' });
    const sevenDone = renderLabelled(seven, old.promise).then(() => gate.finish(seven));
    const thirty = gate.begin({ tab: 'usage', range: '30d' });
    const thirtyDone = renderLabelled(thirty, current.promise).then(() => gate.finish(thirty));

    current.resolve('thirty-day totals');
    await thirtyDone;
    old.resolve('seven-day totals');
    await sevenDone;

    expect(panel.body).toEqual(['usage · 30d', 'thirty-day totals']);
    expect(panel.body.join(' ')).not.toContain('7d');
    expect(panel.busy).toBe(false);
  });

  it('the label of a committed body is the range its own response was requested for', async () => {
    const { panel, gate } = fakePanel();
    const seven = gate.begin({ tab: 'usage', range: '7d' });
    const sevenData = deferred<string>();
    const sevenDone = renderLabelled(seven, sevenData.promise).then(() => gate.finish(seven));
    const thirty = gate.begin({ tab: 'usage', range: '30d' });
    const thirtyData = deferred<string>();
    const thirtyDone = renderLabelled(thirty, thirtyData.promise).then(() => gate.finish(thirty));
    thirtyData.resolve('thirty');
    await thirtyDone;
    sevenData.resolve('seven');
    await sevenDone;
    // The 30d body keeps the 30d label and its 30d value. Nothing shows 7d data under the 30d selection.
    expect(panel.body).toEqual(['usage · 30d', 'thirty']);
  });
});

describe('stale errors, finally and busy', () => {
  it('a stale failure shows no error and does not clear the busy state of the current render', async () => {
    const { panel, gate } = fakePanel();
    const sessions = deferred<string>();
    const local = deferred<string>();

    const first = gate.begin({ tab: 'sessions', range: '30d' });
    const firstDone = renderLabelled(first, sessions.promise).then(
      () => gate.finish(first),
      () => gate.fail(first, (stage) => stage.push('Could not load sessions data'))
    );
    const second = gate.begin({ tab: 'local', range: '30d' });
    const secondDone = renderLabelled(second, local.promise).then(() => gate.finish(second));

    sessions.reject(new Error('daemon timeout'));
    await firstDone;
    expect(panel.body).toEqual(['Loading…']);
    expect(panel.busy).toBe(true);

    local.resolve('local models');
    await secondDone;
    expect(panel.body).toEqual(['local · 30d', 'local models']);
    expect(panel.busy).toBe(false);
    expect(panel.ready).toBe(true);
    expect(panel.readySignals).toBe(1);
  });

  it('a current failure shows its own error and clears busy', async () => {
    const { panel, gate } = fakePanel();
    const usage = deferred<string>();
    const view = gate.begin({ tab: 'usage', range: 'today' });
    const done = renderLabelled(view, usage.promise).then(
      () => gate.finish(view),
      () => gate.fail(view, (stage) => stage.push('Could not load usage data'))
    );
    usage.reject(new Error('daemon down'));
    await done;
    expect(panel.body).toEqual(['Could not load usage data']);
    expect(panel.busy).toBe(false);
    expect(panel.ready).toBe(false);
    expect(panel.readySignals).toBe(0);
  });

  it('a stale render that finishes later never clears busy while a newer one is still loading', async () => {
    const { panel, gate } = fakePanel();
    const a = gate.begin({ tab: 'limits', range: 'today' });
    const b = gate.begin({ tab: 'usage', range: 'today' });
    gate.finish(a); // the older render completes: nothing to commit, busy stays on for b
    expect(panel.busy).toBe(true);
    expect(panel.body).toEqual(['Loading…']);
    expect(panel.ready).toBe(false);
    gate.finish(b);
    expect(panel.busy).toBe(false);
    expect(panel.ready).toBe(true);
    expect(panel.readySignals).toBe(1);
  });
});

describe('the visible body agrees with the selection', () => {
  it('navigating clears the old body while the new one loads, so no other tab shows under the new selection', async () => {
    const { panel, gate } = fakePanel();
    const usageFirst = gate.begin({ tab: 'usage', range: '7d' });
    const usageData = deferred<string>();
    const usageDone = renderLabelled(usageFirst, usageData.promise).then(() => gate.finish(usageFirst));
    usageData.resolve('usage totals');
    await usageDone;
    expect(panel.body).toEqual(['usage · 7d', 'usage totals']);

    const limits = gate.begin({ tab: 'local', range: '7d' });
    expect(panel.body).toEqual(['Loading…']); // the loading placeholder replaces the old body at selection
    expect(panel.busy).toBe(true);
    const localData = deferred<string>();
    const localDone = renderLabelled(limits, localData.promise).then(() => gate.finish(limits));
    localData.resolve('local');
    await localDone;
    expect(panel.body).toEqual(['local · 7d', 'local']);
  });

  it('a refresh of the same selection keeps the visible body until the new one is committed', async () => {
    const { panel, gate } = fakePanel();
    const first = gate.begin({ tab: 'usage', range: '7d' });
    const firstData = deferred<string>();
    const firstDone = renderLabelled(first, firstData.promise).then(() => gate.finish(first));
    firstData.resolve('before refresh');
    await firstDone;

    const refresh = gate.begin({ tab: 'usage', range: '7d' });
    expect(panel.body).toEqual(['usage · 7d', 'before refresh']); // not cleared on a same-selection refresh
    expect(panel.ready).toBe(false); // a visible previous body is not a finished new read
    const refreshData = deferred<string>();
    const refreshDone = renderLabelled(refresh, refreshData.promise).then(() => gate.finish(refresh));
    refreshData.resolve('after refresh');
    await refreshDone;
    expect(panel.body).toEqual(['usage · 7d', 'after refresh']);
  });

  it('a same-selection refresh that starts before an older response lands keeps the newer response', async () => {
    const { panel, gate } = fakePanel();
    const older = gate.begin({ tab: 'sessions', range: '7d' });
    const olderData = deferred<string>();
    const olderDone = renderLabelled(older, olderData.promise).then(() => gate.finish(older));
    const newer = gate.begin({ tab: 'sessions', range: '7d' });
    const newerData = deferred<string>();
    const newerDone = renderLabelled(newer, newerData.promise).then(() => gate.finish(newer));

    newerData.resolve('fresh rows');
    await newerDone;
    olderData.resolve('old rows');
    await olderDone;
    expect(panel.body).toEqual(['sessions · 7d', 'fresh rows']);
    expect(panel.busy).toBe(false);
  });
});
