/**
 * The Doctor overlay and badge (src/tray/renderer/doctor-view.ts), driven by controlled responses. Each expected final state is a
 * literal written here. The fake host records the overlay's open state, its content, the trigger's expanded state, the badge, and the trigger's pending cue.
 * The composition tests put the real per-key cache (request-cache.ts) behind the coordinator, as app.ts does.
 */
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/tray/renderer/api-types.js';
import { DoctorView, type DoctorContent, type ReadOrigin } from '../../src/tray/renderer/doctor-view.js';
import { RequestCache } from '../../src/tray/renderer/request-cache.js';

const NONE: DoctorReport = { warnings: [] } as unknown as DoctorReport;
const WARN = (text: string): DoctorReport => ({ warnings: [text] }) as unknown as DoctorReport;

function fakeHost() {
  return {
    open: false,
    expanded: false,
    badge: false,
    pending: false,
    /** The pending cue when the overlay last opened: it must already be cleared. */
    pendingAtOpen: null as boolean | null,
    content: null as DoctorContent | null,
    renderContent(content: DoctorContent) {
      this.content = content;
    },
    setOpen(open: boolean) {
      this.open = open;
      this.expanded = open;
      if (open) this.pendingAtOpen = this.pending;
    },
    setBadge(hasWarnings: boolean) {
      this.badge = hasWarnings;
    },
    setPending(pending: boolean) {
      this.pending = pending;
    },
  };
}

/** Each request the view starts gets its own response, which the test resolves or rejects by hand, in start order. */
function fakeDoctor() {
  const host = fakeHost();
  const requests: Array<{ resolve(r: DoctorReport): void; reject(e: Error): void }> = [];
  const load = (): Promise<DoctorReport> =>
    new Promise<DoctorReport>((resolve, reject) => {
      requests.push({ resolve, reject });
    });
  const view = new DoctorView(host, load);
  return { host, view, requests };
}

const read = (view: DoctorView, origin: ReadOrigin): Promise<void> => view.refreshBadge(origin);

describe('the trigger while an opening is pending', () => {
  it('exactly two trigger clicks while loading, then every response resolves: the overlay stays hidden and no second request is made', async () => {
    const { host, view, requests } = fakeDoctor();
    const first = view.toggle();
    expect(host.pending).toBe(true);
    const second = view.toggle(); // cancels the pending opening
    expect(host.pending).toBe(false);
    requests[0]!.resolve(WARN('disk low'));
    await Promise.all([first, second]);
    expect(requests).toHaveLength(1);
    expect(host.pending).toBe(false);
    expect(host.open).toBe(false);
    expect(host.expanded).toBe(false);
    expect(host.content).toBeNull();
    expect(host.badge).toBe(false);
    expect(view.isPending()).toBe(false);
  });

  it('a third click after a cancelled opening starts a fresh opening, which opens with its report', async () => {
    const { host, view, requests } = fakeDoctor();
    const first = view.toggle();
    const second = view.toggle();
    const third = view.toggle();
    requests[0]!.resolve(WARN('stale'));
    requests[1]!.resolve(WARN('fresh'));
    await Promise.all([first, second, third]);
    expect(requests).toHaveLength(2);
    expect(host.open).toBe(true);
    expect(host.expanded).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('fresh') });
  });

  it('Escape-style close while an opening is pending cancels it: the overlay stays closed when the report arrives', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    view.close();
    expect(host.pending).toBe(false);
    requests[0]!.resolve(WARN('disk low'));
    await opening;
    expect(host.open).toBe(false);
    expect(host.content).toBeNull();
    expect(host.badge).toBe(false);
  });

  it('cancel, then reopen: the old opening succeeding late keeps the new opening pending, and the new report clears it', async () => {
    const { host, view, requests } = fakeDoctor();
    const old = view.toggle(); // request 0
    view.close();
    const reopened = view.toggle(); // request 1
    expect(host.pending).toBe(true);
    requests[0]!.resolve(WARN('old'));
    await old;
    expect(host.pending).toBe(true);
    expect(host.open).toBe(false);
    expect(host.content).toBeNull();
    requests[1]!.resolve(NONE);
    await reopened;
    expect(host.pending).toBe(false);
    expect(host.pendingAtOpen).toBe(false);
    expect(host.content).toEqual({ kind: 'report', report: NONE });
  });

  it('cancel, then reopen: the old opening failing late keeps the new opening pending, and the new failure clears it', async () => {
    const { host, view, requests } = fakeDoctor();
    const old = view.toggle(); // request 0
    view.close();
    const reopened = view.toggle(); // request 1
    requests[0]!.reject(new Error('old failure'));
    await old;
    expect(host.pending).toBe(true);
    expect(host.open).toBe(false);
    requests[1]!.reject(new Error('daemon unreachable'));
    await reopened;
    expect(host.pending).toBe(false);
    expect(host.pendingAtOpen).toBe(false);
    expect(host.content).toEqual({ kind: 'error', message: 'daemon unreachable' });
  });
});

describe('a Refresh click retires older results at once, while the tab body is still loading', () => {
  it('the click alone retires an older opening: before any new read starts, the late opening cannot open the overlay', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    view.retire();
    expect(view.isPending()).toBe(false);
    expect(host.pending).toBe(false);
    requests[0]!.resolve(WARN('older opening'));
    await opening;
    expect(host.open).toBe(false);
    expect(host.content).toBeNull();
    expect(host.badge).toBe(false);
  });

  it('the click alone retires an older badge read: its late result does not set the badge', async () => {
    const { host, view, requests } = fakeDoctor();
    const olderBadge = read(view, 'click');
    view.retire();
    requests[0]!.resolve(WARN('older read'));
    await olderBadge;
    expect(host.badge).toBe(false);
    expect(host.open).toBe(false);
  });

  it('a pending opening cancelled by the click stays closed when the held refresh resolves', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle(); // request 0
    view.retire(); // the click
    const refreshing = read(view, 'click'); // request 1, held
    requests[0]!.resolve(WARN('old opening'));
    await opening;
    expect(host.open).toBe(false);
    expect(host.badge).toBe(false);
    requests[1]!.resolve(WARN('fresh'));
    await refreshing;
    expect(host.open).toBe(false);
    expect(host.content).toBeNull();
    expect(host.badge).toBe(true);
  });

  it('an older badge read that resolves first leaves an open overlay on its last good report; the newest read then updates it', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle(); // request 0
    requests[0]!.resolve(NONE);
    await opening;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: NONE });

    const older = read(view, 'click'); // request 1, started before the click
    view.retire();
    const newest = read(view, 'click'); // request 2
    requests[1]!.resolve(WARN('older read'));
    await older;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: NONE });
    expect(host.badge).toBe(false);

    requests[2]!.resolve(WARN('fresh'));
    await newest;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('fresh') });
    expect(host.badge).toBe(true);
  });
});

describe('an older read cannot overwrite a newer opening', () => {
  it('old Refresh read, then a new opening that resolves first, then the old read last: the newer report stays', async () => {
    const { host, view, requests } = fakeDoctor();
    const oldRead = read(view, 'click'); // request 0
    const newOpening = view.toggle(); // request 1, newer
    requests[1]!.resolve(WARN('new'));
    await newOpening;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('new') });
    expect(host.badge).toBe(true);

    requests[0]!.resolve(NONE);
    await oldRead;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('new') });
    expect(host.badge).toBe(true);
  });
});

describe('background reads at boot do not supersede the user', () => {
  it('a background read started during a pending user opening does not cancel it: the overlay opens with the user report (background first)', async () => {
    const { host, view, requests } = fakeDoctor();
    const background = read(view, 'background'); // request 0, boot
    const opening = view.toggle(); // request 1, the user's opening
    requests[0]!.resolve(NONE); // the background read resolves first, while the overlay is closed
    await background;
    expect(host.open).toBe(false);
    expect(host.badge).toBe(false);
    expect(host.pending).toBe(true);
    requests[1]!.resolve(WARN('user report'));
    await opening;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('user report') });
    expect(host.badge).toBe(true);
  });

  it('the same when the user opening resolves first and the background read last: the open overlay keeps the user report', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle(); // request 0
    const background = read(view, 'background'); // request 1, started during the pending opening
    requests[0]!.resolve(WARN('user report'));
    await opening;
    expect(host.open).toBe(true);
    requests[1]!.resolve(NONE); // the background read arrives last
    await background;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('user report') });
    expect(host.badge).toBe(true);
  });

  it('a background read never changes an open overlay, even when it is the newest read', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    requests[0]!.resolve(WARN('opened'));
    await opening;
    const background = read(view, 'background');
    requests[1]!.resolve(NONE);
    await background;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('opened') });
    expect(host.badge).toBe(true);
  });
});

describe('opening, closing and failures', () => {
  it('opens with the report that arrives, and shows its warnings', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    expect(host.pending).toBe(true);
    expect(host.open).toBe(false);
    requests[0]!.resolve(WARN('disk low'));
    await opening;
    expect(host.open).toBe(true);
    expect(host.pendingAtOpen).toBe(false);
    expect(host.expanded).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('disk low') });
    expect(host.badge).toBe(true);
  });

  it('the trigger again closes an open overlay without a request', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    requests[0]!.resolve(NONE);
    await opening;
    await view.toggle();
    expect(host.open).toBe(false);
    expect(host.expanded).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('a failed opening shows a contained error inside the overlay, not an unhandled rejection', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    requests[0]!.reject(new Error('daemon unreachable'));
    await expect(opening).resolves.toBeUndefined();
    expect(host.open).toBe(true);
    expect(host.pendingAtOpen).toBe(false);
    expect(host.content).toEqual({ kind: 'error', message: 'daemon unreachable' });
  });

  it('a failed Refresh keeps the last good badge and the last good open report', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    requests[0]!.resolve(NONE);
    await opening;
    const failing = read(view, 'click');
    requests[1]!.reject(new Error('timeout'));
    await expect(failing).rejects.toThrow('timeout');
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: NONE });
    expect(host.badge).toBe(false);
  });

  it('a Refresh after closing updates the badge and does not reopen the overlay', async () => {
    const { host, view, requests } = fakeDoctor();
    const opening = view.toggle();
    requests[0]!.resolve(NONE);
    await opening;
    view.close();
    const refreshing = read(view, 'click');
    requests[1]!.resolve(WARN('while closed'));
    await refreshing;
    expect(host.open).toBe(false);
    expect(host.badge).toBe(true);
  });
});

describe('the Doctor report cache behind the coordinator (controlled responses, as app.ts wires it)', () => {
  /** The coordinator's report source is the per-key cache, and every request it starts is counted. */
  function wired() {
    const cache = new RequestCache<'doctor', DoctorReport>();
    const requests: Array<{ resolve(r: DoctorReport): void; reject(e: Error): void }> = [];
    const fetch = (): Promise<DoctorReport> =>
      new Promise<DoctorReport>((resolve, reject) => {
        requests.push({ resolve, reject });
      });
    const host = fakeHost();
    const view = new DoctorView(host, () => cache.load('doctor', fetch));
    return { cache, host, view, requests };
  }

  it('a held bootstrap report that resolves after the user opened does not replace the newest report on reopen', async () => {
    const { cache, host, view, requests } = wired();
    const bootstrap = read(view, 'background'); // request 0, held
    const opening = view.toggle(); // request 1, the newest request for the key
    requests[1]!.resolve(WARN('CurrentFixtureWarning'));
    await opening;
    requests[0]!.resolve(NONE); // the bootstrap response arrives last
    await bootstrap;
    expect(host.content).toEqual({ kind: 'report', report: WARN('CurrentFixtureWarning') });

    view.close();
    await view.toggle(); // reopen: the cache holds the newest report, and no request is made
    expect(requests).toHaveLength(2);
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('CurrentFixtureWarning') });
    expect(cache.get('doctor')).toEqual(WARN('CurrentFixtureWarning'));
  });

  it('a user opening held behind the Sessions load survives a later background read, and the overlay opens with the user report', async () => {
    const { host, view, requests } = wired();
    const opening = view.toggle(); // request 0: the user's click, held
    const background = read(view, 'background'); // request 1: the boot read, started later
    requests[1]!.resolve(WARN('boot report')); // the background read resolves first; the overlay is still pending, so it sets the badge
    await background;
    expect(host.badge).toBe(true);
    expect(host.pending).toBe(true);
    requests[0]!.resolve(WARN('user report'));
    await opening;
    expect(host.open).toBe(true);
    expect(host.content).toEqual({ kind: 'report', report: WARN('user report') });
    expect(host.badge).toBe(true);
  });
});
