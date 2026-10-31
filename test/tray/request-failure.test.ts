/**
 * src/tray/renderer/request-failure.ts — how a timed-out read is recognised after the IPC crossing, and what the panel then holds
 * (with the real RequestCache and ViewGate, composed the way app.ts's renderCurrentTab composes them; the DOM itself is not run here).
 *
 * The IPC shape. ipcMain.handle replies with `String(error)` only, and ipcRenderer.invoke rejects with
 * `new Error("Error invoking remote method '<channel>': " + thatString)`. `throughIpc` reproduces that from a real client error, so
 * the class and its fields are gone, as in the tray.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  DaemonIdentityError,
  DaemonTimeoutError,
  LOCAL_TIMEOUT_MARKER as CLIENT_MARKER,
} from '../../src/tray/api-client.js';
import { LOCAL_TIMEOUT_COPY, LOCAL_TIMEOUT_MARKER, failureMessage, isLocalTimeout } from '../../src/tray/renderer/request-failure.js';
import { RequestCache } from '../../src/tray/renderer/request-cache.js';
import { ViewGate } from '../../src/tray/renderer/view-gate.js';

function throughIpc(channel: string, err: Error): Error {
  return new Error(`Error invoking remote method '${channel}': ${String(err)}`);
}

const timeoutViaIpc = (): Error => throughIpc('tokenelo:getCoverage', new DaemonTimeoutError('/v1/coverage', 20_000));

describe('recognising a timeout after IPC', () => {
  it('the renderer and the client use the same marker', () => {
    expect(LOCAL_TIMEOUT_MARKER).toBe(CLIENT_MARKER);
  });

  it('a client timeout that crossed IPC lost its class, and is still recognised by its marker', () => {
    const err = timeoutViaIpc();
    expect(err).not.toBeInstanceOf(DaemonTimeoutError);
    expect(err.name).toBe('Error');
    expect(isLocalTimeout(err)).toBe(true);
    expect(failureMessage(err)).toBe('Tokenelo is taking longer than expected to respond. Try again in a moment.');
    expect(LOCAL_TIMEOUT_COPY).toBe('Tokenelo is taking longer than expected to respond. Try again in a moment.');
  });

  it('also recognised directly, and as a copied error object with no prototype (a contextBridge copy)', () => {
    const direct = new DaemonTimeoutError('/v1/hello', 20_000);
    expect(failureMessage(direct)).toBe(LOCAL_TIMEOUT_COPY);
    expect(isLocalTimeout({ message: timeoutViaIpc().message })).toBe(true);
  });

  it('every other failure keeps exactly the message it had before', () => {
    const http = throughIpc('tokenelo:getSummary', new ApiError('GET /v1/summary?range=today → HTTP 503', 503));
    const identity = throughIpc(
      'tokenelo:getSummary',
      new DaemonIdentityError('daemon identity challenge failed: the server on http://127.0.0.1:47821 could not prove it holds the real API token — refusing to send it (possible port squatter)')
    );
    const refused = throughIpc('tokenelo:getSummary', new ApiError('daemon identity challenge failed: GET /v1/hello — fetch failed'));
    const startup = throughIpc('tokenelo:getSummary', new ApiError('daemon API token not found at /tmp/api-token — is the daemon running and has it written its token file?'));
    for (const err of [http, identity, refused, startup]) {
      expect(isLocalTimeout(err)).toBe(false);
      expect(failureMessage(err)).toBe(err.message);
    }
  });

  it('words alone are not a timeout: only the marker at the start or after ": " counts', () => {
    expect(isLocalTimeout(new Error('The operation timed out'))).toBe(false);
    expect(isLocalTimeout(new Error('Tokenelo is taking longer than expected to respond.'))).toBe(false);
    expect(isLocalTimeout(new Error(`daemon said x${LOCAL_TIMEOUT_MARKER} later`))).toBe(false);
    expect(isLocalTimeout(new DOMException('This operation was aborted', 'AbortError'))).toBe(false);
    expect(isLocalTimeout(`${LOCAL_TIMEOUT_MARKER} as a bare string`)).toBe(false);
    expect(isLocalTimeout(null)).toBe(false);
    expect(isLocalTimeout(undefined)).toBe(false);
    expect(failureMessage('plain text')).toBe('plain text');
  });
});

describe('what the panel holds after a timed-out Refresh', () => {
  type Key = { tab: string; range: string };

  function panelDouble() {
    const panel = { visible: [] as string[], busy: false, ready: false };
    const gate = new ViewGate<string[], Key>({
      createStage: () => [],
      commit: (stage) => {
        panel.visible = [...stage];
      },
      clear: () => {
        panel.visible = ['Loading…'];
      },
      setBusy: (busy) => {
        panel.busy = busy;
      },
      setReady: (ready) => { panel.ready = ready; },
    });
    return { panel, gate };
  }

  it('the old body is replaced by the timeout notice (never kept unlabelled, never an empty or zero result), and nothing is cached', async () => {
    const { panel, gate } = panelDouble();
    const cache = new RequestCache<'coverage', string>();
    const key = { tab: 'coverage', range: 'today' };

    const first = gate.begin(key);
    expect(panel.ready).toBe(false);
    first.stage.push(await cache.load('coverage', async () => '3/3 collectors online'));
    gate.finish(first);
    expect(panel.visible).toEqual(['3/3 collectors online']);
    expect(panel.ready).toBe(true);

    // Refresh: caches cleared, the same selection keeps its old body while loading, then the read times out.
    cache.clear();
    const refresh = gate.begin(key);
    expect(panel.ready).toBe(false);
    expect(panel.visible).toEqual(['3/3 collectors online']);
    try {
      refresh.stage.push(await cache.load('coverage', () => Promise.reject(timeoutViaIpc())));
      gate.finish(refresh);
    } catch (err) {
      gate.fail(refresh, (stage) => stage.splice(0, stage.length, 'Could not load coverage data', failureMessage(err), 'Try again'));
    }

    expect(panel.visible).toEqual(['Could not load coverage data', LOCAL_TIMEOUT_COPY, 'Try again']);
    expect(panel.busy).toBe(false);
    expect(panel.ready).toBe(false);
    expect(cache.get('coverage')).toBeUndefined();
  });

  it('Try again is one new request, started by the user, and its success is what fills the cache', async () => {
    const cache = new RequestCache<'coverage', string>();
    let requests = 0;
    const read = (outcome: () => Promise<string>) => () => {
      requests += 1;
      return outcome();
    };
    await expect(cache.load('coverage', read(() => Promise.reject(timeoutViaIpc())))).rejects.toThrow(LOCAL_TIMEOUT_MARKER);
    await Promise.resolve();
    expect(requests).toBe(1); // nothing was retried on its own
    expect(await cache.load('coverage', read(async () => 'fresh coverage'))).toBe('fresh coverage');
    expect(cache.get('coverage')).toBe('fresh coverage');
  });

  it('a timeout from a superseded render does not replace the newer body', async () => {
    const { panel, gate } = panelDouble();
    const older = gate.begin({ tab: 'coverage', range: 'today' });
    const newer = gate.begin({ tab: 'now', range: 'today' });
    newer.stage.push('Now body');
    gate.finish(newer);
    gate.fail(older, (stage) => stage.push(failureMessage(timeoutViaIpc())));
    expect(panel.visible).toEqual(['Now body']);
    expect(panel.ready).toBe(true);
  });
});
