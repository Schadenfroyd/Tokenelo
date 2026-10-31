import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiClient } from '../../src/tray/api-client.js';
import { defaultConfig, saveConfig } from '../../src/daemon/config.js';
import { getFleetPeerTokenPath, FLEET_PORT } from '../../src/daemon/fleet.js';
import { getPaths } from '../../src/daemon/paths.js';

const syntheticPeerTokenFiles = vi.hoisted(() => new Map<string, { permissionChecks: number }>());
vi.mock('../../src/daemon/fleet.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/fleet.js')>();
  return {
    ...actual,
    readFleetPeerToken: (
      paths: Parameters<typeof actual.readFleetPeerToken>[0],
      label: Parameters<typeof actual.readFleetPeerToken>[1],
    ) => {
      if (process.platform !== 'win32') return actual.readFleetPeerToken(paths, label);
      const tokenPath = actual.getFleetPeerTokenPath(paths, label);
      const owned = syntheticPeerTokenFiles.get(tokenPath);
      if (!owned) throw new Error('peer token path is not a registered test fixture');
      return actual.readFleetPeerToken(paths, label, filePath => {
        if (filePath !== tokenPath) throw new Error('peer token permission check escaped the registered fixture');
        owned.permissionChecks++;
        return true;
      });
    },
  };
});

function registerPeerTokenFile(filePath: string): void {
  if (process.platform === 'win32') syntheticPeerTokenFiles.set(filePath, { permissionChecks: 0 });
}

function assertPeerTokenPermissionCheck(filePath: string): void {
  if (process.platform === 'win32') expect(syntheticPeerTokenFiles.get(filePath)?.permissionChecks).toBeGreaterThan(0);
}

function unregisterPeerTokenFile(filePath: string | undefined): void {
  if (filePath) syntheticPeerTokenFiles.delete(filePath);
}

// P1-1 (2026-10-04): an idle peer is a valid empty state, not an identity failure. This runs the real createApiClient fleet overview with an
// injected fetch: a local daemon (identity proof by its token), and one peer over a tailnet address with its own proof. Each case is one peer
// payload shape; the peer's status is what the Fleet UI receives.

const LOCAL_TOKEN = 'a'.repeat(64);
const PEER_TOKEN = 'b'.repeat(64);
const PEER_URL = `http://100.100.1.2:${FLEET_PORT}`;
const PEER_LABEL = 'idle-peer';
const RANGE = 'today';

function emptyTotals(priceStatus: unknown, extra: Record<string, unknown> = {}) {
  return {
    events: 0,
    tokens: { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 },
    apiEquivUsd: 0,
    unpricedEvents: 0,
    estimatedPriceEvents: 0,
    priceStatus,
    ...extra,
  };
}

function peerBody(totals: Record<string, unknown>) {
  return { host: PEER_LABEL, range: RANGE, generatedAt: Date.now(), totals, bySource: {}, byModel: [], activeTime: { agentMs: 0, wallMs: 0 }, timeseries: { bucketMs: 3_600_000, points: [] } };
}

function hmac(key: string, msg: string): string {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

async function peerStatus(peerTotals: Record<string, unknown> | null): Promise<{ status: string; priceStatus: unknown; events: number } | undefined> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-peer-'));
  let peerTokenFile: string | undefined;
  try {
    const env = { TOKENELO_HOME: home };
    const paths = getPaths({ env });
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const config = defaultConfig();
    config.fleet = { ...config.fleet, peers: [{ label: PEER_LABEL, url: PEER_URL }] } as typeof config.fleet;
    saveConfig(paths, config);
    fs.writeFileSync(paths.apiTokenFile, LOCAL_TOKEN);
    const peerFile = getFleetPeerTokenPath(paths, PEER_LABEL);
    peerTokenFile = peerFile;
    registerPeerTokenFile(peerFile);
    fs.mkdirSync(path.dirname(peerFile), { recursive: true });
    fs.writeFileSync(peerFile, PEER_TOKEN);

    const localSummary = {
      host: config.hostLabel,
      range: RANGE,
      generatedAt: Date.now(),
      totals: emptyTotals('LIST'),
      bySource: {},
      byModel: [],
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('http://127.0.0.1:')) {
        const u = new URL(url);
        if (u.pathname === '/v1/hello') {
          expect(new Headers(init?.headers).has('Authorization')).toBe(false);
          return json({ proof: hmac(LOCAL_TOKEN, u.searchParams.get('nonce') ?? '') });
        }
        if (u.pathname === '/v1/summary') {
          expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${LOCAL_TOKEN}`);
          return json(localSummary);
        }
        return json({}, 404);
      }
      if (url.startsWith(PEER_URL)) {
        const u = new URL(url);
        if (u.pathname === '/v1/fleet/hello') {
          expect(new Headers(init?.headers).has('Authorization')).toBe(false);
          return json({ proof: hmac(PEER_TOKEN, u.searchParams.get('nonce') ?? '') });
        }
        if (u.pathname === '/v1/fleet/summary') {
          expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${PEER_TOKEN}`);
          return json(peerTotals === null ? {} : peerBody(peerTotals));
        }
        return json({}, 404);
      }
      return json({}, 404);
    }) as typeof fetch;

    const client = createApiClient({ baseUrl: `http://127.0.0.1:${9}`, tokenFile: paths.apiTokenFile, env, fetchImpl });
    const overview = await client.getFleetOverview(RANGE as never);
    assertPeerTokenPermissionCheck(peerFile);
    // The peer's own entry as the Fleet UI receives it: status, and the normalised totals of its summary.
    const hosts = (overview as unknown as { hosts: { label: string; status: string; summary?: { totals?: { priceStatus?: unknown; events?: number } } }[] }).hosts;
    const host = hosts.find((h) => h.label === PEER_LABEL);
    return host ? { status: host.status, priceStatus: host.summary?.totals?.priceStatus, events: host.summary?.totals?.events } : undefined;
  } finally {
    unregisterPeerTokenFile(peerTokenFile);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('an idle Fleet peer (zero events) is accepted by the real API client', () => {
  it('zero events with priceStatus null (the corrected empty state) is online and keeps null', async () => {
    const host = await peerStatus(emptyTotals(null));
    expect(host?.status).toBe('online');
    expect(host?.priceStatus).toBeNull();
  });

  it('zero events with priceStatus LIST (already-deployed peers) is online and normalised to null in the Fleet overview', async () => {
    const host = await peerStatus(emptyTotals('LIST'));
    expect(host?.status).toBe('online');
    expect(host?.events).toBe(0);
    expect(host?.priceStatus).toBeNull(); // the normalisation itself, not only the status
  });

  it('zero events with priceStatus ESTIMATE is a contradiction and is untrusted', async () => {
    expect((await peerStatus(emptyTotals('ESTIMATE')))?.status).toBe('untrusted');
  });

  it('events present with more unpriced than events is corrupt and is untrusted', async () => {
    expect((await peerStatus(emptyTotals('UNPRICED', { events: 3, unpricedEvents: 5, estimatedPriceEvents: 0 })))?.status).toBe('untrusted');
  });
});
