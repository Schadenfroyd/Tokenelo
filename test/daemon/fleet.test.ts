import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { SummaryResponse } from '../../src/core/types.js';
import type { TokenCounts } from '../../src/core/types.js';
import { TOKEN_FIELD_KEYS } from '../../src/core/token-field-evidence.js';
import type { Queries } from '../../src/store/queries.js';
import {
  createFleetHttpServer,
  stopFleetReadAdmission,
  FLEET_PORT,
  isTailnetAddress,
  isTailnetPeerUrl,
  ensureFleetToken,
  getFleetPeerTokenPath,
  readFleetPeerToken,
  writeFleetPeerToken,
} from '../../src/daemon/fleet.js';
import { getPaths } from '../../src/daemon/paths.js';

const PORT = 47924;
const ADDRESS = '100.64.0.7';
const TOKEN = 'a'.repeat(64);

const fieldCounts = { knownParts: 1, reportedParts: 1, derivedParts: 0, normalizedParts: 0, assumedParts: 0, notApplicableParts: 0, missingParts: 0, invalidParts: 0, unrecordedParts: 0 };
const fieldValues: Record<(typeof TOKEN_FIELD_KEYS)[number], number> = { inputFresh: 10, cacheRead: 2, output: 4, cacheWrite5m: 1, cacheWrite1h: 2, cacheWriteUnassigned: 3, reasoning: 1 };
const fieldEvidence = Object.fromEntries(TOKEN_FIELD_KEYS.map((key) => [key, { ...fieldCounts, knownValue: fieldValues[key] }])) as NonNullable<TokenCounts['fieldEvidence']>;
const tokens = {
  inputFresh: 10, cacheWrite5m: 1, cacheWrite1h: 2, cacheWriteUnassigned: 3, cacheWriteAssumed1h: 2,
  cacheRead: 2, output: 4, reasoning: 1, countQuality: 'incomplete', ucuCountQuality: 'unrecorded', fieldEvidence,
};
const priceEvidence = { version: 1, events: 2, invalidAmountEvents: 0, unknownStatusEvents: 0, statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false };
// The aggregates the fleet endpoint returns: every supported field carried through, nothing else.
const expectedTotals = {
  events: 2, tokens, apiEquivUsd: 0.25, unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE', priceEvidence,
};
const expectedBySource = {
  claude: { events: 2, tokens, apiEquivUsd: 0.25, unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE', priceEvidence },
};
// What a peer running an older edition may still send in a legacy figure member. It is not part of the projection:
// the member is never read, forwarded or leaked, whatever it holds.
const PEER_FIGURE_VALUE = 987_654;
const peerFigure = {
  value: PEER_FIGURE_VALUE, status: 'MEASURED', mix: { MEASURED: 100, PLACEHOLDER: 0 }, displayable: true,
  note: 'peer-figure-note',
};
const summary = {
  host: 'M4a',
  range: '7d',
  generatedAt: 100,
  totals: { ...expectedTotals, ucu: peerFigure },
  bySource: {
    claude: { ...expectedBySource.claude, ucu: peerFigure },
  },
  activeTime: { agentMs: 40, wallMs: 30 },
  // A hostile or accidentally-expanded query result must not cross this API boundary.
  project: '/Users/example/private-project',
  sessions: [{ sessionId: 'secret-session' }],
} as unknown as SummaryResponse;

const getSummary = vi.fn(async () => summary);
const queries = { getSummary } as unknown as Queries;
let server: http.Server;

beforeAll(async () => {
  server = createFleetHttpServer({ address: ADDRESS, port: PORT, token: TOKEN, queries, host: 'M4a' });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Result { status: number; body: unknown }

function request(
  path: string,
  options: { method?: string; host?: string; token?: string | null; origin?: string } = {}
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `${ADDRESS}:${PORT}` };
    if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
    if (options.origin !== undefined) headers.origin = options.origin;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: options.method ?? 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: text }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Tailscale fleet listener', () => {
  it('recognizes only Tailscale IP ranges and requires the documented fleet port for peers', () => {
    expect(isTailnetAddress('100.64.0.7')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('0.0.0.0')).toBe(false);
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetPeerUrl(`http://100.64.0.8:${FLEET_PORT}`)).toBe(true);
    expect(isTailnetPeerUrl(`http://[fd7a:115c:a1e0::1]:${FLEET_PORT}`)).toBe(true);
    expect(isTailnetPeerUrl(`http://[fd7a:115c:a1e0::1]:${FLEET_PORT}`)).toBe(true);
    expect(isTailnetPeerUrl('http://127.0.0.1:47822')).toBe(false);
    expect(isTailnetPeerUrl('http://100.64.0.8:80')).toBe(false);
  });

  it('answers an identity challenge without auth, then gates aggregate data with the fleet token', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const hello = await request(`/v1/fleet/hello?nonce=${nonce}`, { token: null });
    expect(hello.status).toBe(200);
    expect(hello.body).toEqual({ proof: crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex') });

    expect((await request('/v1/fleet/summary?range=7d', { token: null })).status).toBe(401);
    expect((await request('/v1/fleet/summary?range=7d', { token: 'b'.repeat(64) })).status).toBe(401);
    const malformedByteLength = await request('/v1/fleet/summary?range=7d', { token: 'é'.repeat(TOKEN.length) });
    expect(malformedByteLength.status).toBe(401);
    expect(malformedByteLength.body).toEqual({ error: 'unauthorized' });
    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      host: 'M4a',
      range: '7d',
      generatedAt: 100,
      totals: expectedTotals,
      bySource: expectedBySource,
      activeTime: { agentMs: 40, wallMs: 30 },
    });
    expect(JSON.stringify(response.body)).not.toContain('/Users/example/private-project');
    expect(JSON.stringify(response.body)).not.toContain('secret-session');
    expect(JSON.stringify(response.body)).not.toContain(String(PEER_FIGURE_VALUE));
    expect(JSON.stringify(response.body)).not.toContain('peer-figure-note');
    expect(getSummary).toHaveBeenCalledWith('7d', { signal: expect.any(AbortSignal) });
  });

  it('deeply projects hostile nested query fields while preserving supported aggregate quality fields', async () => {
    const hostile = structuredClone(summary) as unknown as Record<string, any>;
    hostile.totals.sessionId = 'fleet-private-total-session';
    hostile.totals.tokens.projectPath = 'fleet-private-token-path';
    hostile.totals.tokens.fieldEvidence.privateSession = { sessionId: 'fleet-private-field-session' };
    hostile.totals.tokens.fieldEvidence.inputFresh.accountName = 'fleet-private-account';
    hostile.totals.ucu.branch = 'fleet-private-branch';
    hostile.totals.ucu.mix['private-session'] = 'fleet-private-status';
    hostile.totals.ucu.nested = { projectPath: 'fleet-private-figure-path', list: [{ sessionId: 'fleet-private-figure-session' }] };
    hostile.bySource.claude.ucu.accountName = 'fleet-private-source-figure-account';
    hostile.totals.priceEvidence.repoRoot = 'fleet-private-price-path';
    hostile.bySource.claude.repoRoot = 'fleet-private-source-path';
    hostile.bySource.claude.tokens.sessionId = 'fleet-private-source-session';
    hostile.bySource['private-session'] = { events: 1, sessionId: 'fleet-private-source-key' };
    hostile.activeTime.accountName = 'fleet-private-time-account';
    getSummary.mockResolvedValueOnce(hostile as unknown as SummaryResponse);

    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      host: 'M4a', range: '7d', generatedAt: 100,
      totals: expectedTotals, bySource: expectedBySource, activeTime: summary.activeTime,
    });
    expect(JSON.stringify(response.body)).not.toContain('fleet-private');
  });

  it.each([
    ['a string', (_peer: any) => 'garbage'],
    ['a number', (_peer: any) => 12],
    ['null', (_peer: any) => null],
    ['an array', (_peer: any) => [PEER_FIGURE_VALUE, 'peer-garbage-figure']],
    ['an object with wrong-typed fields', (_peer: any) => ({
      value: { sessionId: 'peer-garbage-figure' }, status: 'NOT-A-STATUS', mix: 'peer-garbage-figure',
      displayable: 'yes', secret: PEER_FIGURE_VALUE,
    })],
    ['an inconsistent figure', (_peer: any) => ({ value: PEER_FIGURE_VALUE, status: 'MEASURED', mix: { MEASURED: 50 }, displayable: false })],
    ['absent', undefined],
  ])('ignores a peer whose legacy figure member is %s: nothing of it is projected or leaked', async (_label, replacement) => {
    const peer = structuredClone(summary) as unknown as Record<string, any>;
    for (const aggregate of [peer.totals, peer.bySource.claude]) {
      if (replacement === undefined) delete aggregate.ucu;
      else aggregate.ucu = replacement(aggregate);
    }
    getSummary.mockResolvedValueOnce(peer as unknown as SummaryResponse);

    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      host: 'M4a', range: '7d', generatedAt: 100,
      totals: expectedTotals, bySource: expectedBySource, activeTime: summary.activeTime,
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(String(PEER_FIGURE_VALUE));
    expect(serialized).not.toContain('peer-garbage-figure');
    expect(serialized).not.toContain('peer-figure-note');
  });

  it('withholds the aggregate when a required scalar is an object, without serializing its nested data', async () => {
    const malformed = structuredClone(summary) as unknown as Record<string, any>;
    malformed.totals.tokens.output = { sessionId: 'fleet-private-malformed-session' };
    getSummary.mockResolvedValueOnce(malformed as unknown as SummaryResponse);

    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'read_unavailable' });
    expect(JSON.stringify(response.body)).not.toContain('fleet-private');
  });

  it.each([
    ['contradictory total price counts', (value: any) => {
      value.totals.unpricedEvents = 2;
      value.totals.estimatedPriceEvents = 1;
      value.totals.priceStatus = 'UNPRICED';
    }],
    ['contradictory source price status', (value: any) => { value.bySource.claude.priceStatus = 'LIST'; }],
    ['mismatched price-evidence scope', (value: any) => { value.totals.priceEvidence.events = 1; }],
    ['token field evidence beyond its total', (value: any) => { value.totals.tokens.fieldEvidence.inputFresh.knownValue = 11; }],
  ])('withholds semantically inconsistent %s', async (_label, mutate) => {
    const malformed = structuredClone(summary) as any;
    mutate(malformed);
    getSummary.mockResolvedValueOnce(malformed as SummaryResponse);
    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'read_unavailable' });
  });


  it.each([
    ['optional count', (value: any) => { value.totals.tokens.cacheWriteUnassigned = { accountName: 'fleet-private-invalid' }; }],
    ['optional quality', (value: any) => { value.totals.tokens.countQuality = { sessionId: 'fleet-private-invalid' }; }],
    ['optional field evidence', (value: any) => { value.totals.tokens.fieldEvidence.inputFresh.knownValue = { sessionId: 'fleet-private-invalid' }; }],
    ['optional price evidence', (value: any) => { value.totals.priceEvidence.events = { projectPath: 'fleet-private-invalid' }; }],
    ['optional source count', (value: any) => { value.bySource.claude.estimatedPriceEvents = { sessionId: 'fleet-private-invalid' }; }],
  ])('withholds malformed supplied known %s instead of disguising it as legacy absence', async (_label, mutate) => {
    const malformed = structuredClone(summary) as any;
    mutate(malformed);
    getSummary.mockResolvedValueOnce(malformed as SummaryResponse);
    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'read_unavailable' });
    expect(JSON.stringify(response.body)).not.toContain('fleet-private');
  });

  it('preserves legacy optional omissions and undefined without inventing zero quality fields', async () => {
    const bareTokens = { inputFresh: 10, cacheWrite5m: 1, cacheWrite1h: 2, cacheRead: 2, output: 4, reasoning: 1 };
    const bareFigure = { value: 12, status: 'MEASURED', mix: { MEASURED: 100 }, displayable: true };
    const bareTotals = { events: 2, tokens: bareTokens, apiEquivUsd: 0.25 };
    const legacy = {
      ...summary,
      totals: { ...bareTotals, ucu: bareFigure, unpricedEvents: undefined, priceEvidence: undefined,
        tokens: { ...bareTokens, fieldEvidence: undefined } },
      bySource: { claude: { ...bareTotals, ucu: bareFigure, priceStatus: undefined } },
    };
    getSummary.mockResolvedValueOnce(legacy as unknown as SummaryResponse);
    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      host: 'M4a', range: '7d', generatedAt: 100, totals: { ...bareTotals },
      bySource: { claude: { ...bareTotals } }, activeTime: summary.activeTime,
    });
  });

  it('rejects browser Origins, incorrect Host values, mutations, bad ranges, and non-fleet routes', async () => {
    expect((await request('/v1/fleet/summary', { origin: 'https://example.com' })).status).toBe(403);
    expect((await request('/v1/fleet/summary', { host: `attacker.example:${PORT}` })).status).toBe(403);
    expect((await request('/v1/fleet/summary', { method: 'POST' })).status).toBe(405);
    expect((await request('/v1/fleet/summary?range=forever')).status).toBe(400);
    expect((await request('/v1/doctor')).status).toBe(404);
  });

  it('refuses to construct a listener bound outside the Tailscale address range', () => {
    expect(() => createFleetHttpServer({ address: '0.0.0.0', token: TOKEN, queries, host: 'M4a' })).toThrow(/Tailscale/);
  });

  it('creates host and peer secrets in separate data files with traversal-safe peer paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-secret-'));
    try {
      const paths = getPaths({ env: { TOKENELO_HOME: home } });
      const ownToken = ensureFleetToken(paths, () => true, () => true);
      expect(ownToken).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(paths.fleetTokenFile, 'utf8').trim()).toBe(ownToken);
      expect(ensureFleetToken(paths, () => true, () => true)).toBe(ownToken);

      const peerFile = writeFleetPeerToken(paths, 'ryzen', TOKEN, () => true, () => true);
      expect(peerFile).toBe(getFleetPeerTokenPath(paths, 'ryzen'));
      expect(readFleetPeerToken(paths, 'ryzen', () => true)).toBe(TOKEN);
      expect(getFleetPeerTokenPath(paths, '../../escape')).toContain(path.join(paths.dataDir, 'fleet-peers'));
      fs.writeFileSync(peerFile, 'invalid');
      expect(readFleetPeerToken(paths, 'ryzen')).toBeNull();
      if (process.platform !== 'win32') {
        expect(fs.statSync(paths.fleetTokenFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(peerFile).mode & 0o777).toBe(0o600);
      }
      expect(() => writeFleetPeerToken(paths, 'ryzen', 'bad-token')).toThrow(/64 hex/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('commits an existing peer replacement only after protecting an empty sibling', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-peer-replace-'));
    try {
      const paths = getPaths({ env: { TOKENELO_HOME: home } });
      const peer = getFleetPeerTokenPath(paths, 'ryzen');
      fs.mkdirSync(path.dirname(peer), { recursive: true });
      const previous = 'c'.repeat(64) + '\n';
      fs.writeFileSync(peer, previous, { mode: 0o600 });
      let checkedEmptySibling = false;
      const returned = writeFleetPeerToken(paths, 'ryzen', TOKEN, (temporary) => {
        expect(temporary).not.toBe(peer);
        expect(fs.readFileSync(temporary, 'utf8')).toBe('');
        expect(fs.readFileSync(peer, 'utf8')).toBe(previous);
        checkedEmptySibling = true;
        return true;
      }, () => true);
      expect(checkedEmptySibling).toBe(true);
      expect(returned).toBe(peer);
      expect(fs.readFileSync(peer, 'utf8')).toBe(TOKEN + '\n');
      expect(fs.readdirSync(path.dirname(peer))).toEqual([path.basename(peer)]);
      if (process.platform !== 'win32') expect(fs.statSync(peer).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses reused host and peer tokens when user-only ACL verification fails', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-acl-'));
    try {
      const paths = getPaths({ env: { TOKENELO_HOME: home } });
      fs.mkdirSync(paths.dataDir, { recursive: true });
      const originalBytes = TOKEN + '\n';
      fs.writeFileSync(paths.fleetTokenFile, originalBytes, { mode: 0o600 });
      expect(() => ensureFleetToken(paths, () => false)).toThrow(/could not restrict fleet-token/);
      expect(fs.readFileSync(paths.fleetTokenFile, 'utf8')).toBe(originalBytes);

      const peerFile = getFleetPeerTokenPath(paths, 'ryzen');
      fs.mkdirSync(path.dirname(peerFile), { recursive: true });
      fs.writeFileSync(peerFile, originalBytes, { mode: 0o600 });
      expect(readFleetPeerToken(paths, 'ryzen', () => false)).toBeNull();
      expect(fs.readFileSync(peerFile, 'utf8')).toBe(originalBytes);

      const writeFailure = getFleetPeerTokenPath(paths, 'codex');
      const previousPeerBytes = 'c'.repeat(64) + '\n';
      fs.writeFileSync(writeFailure, previousPeerBytes, { mode: 0o600 });
      let emptyTemporaryFileSeen = false;
      expect(() => writeFleetPeerToken(paths, 'codex', TOKEN, (temporary) => {
        emptyTemporaryFileSeen = fs.statSync(temporary).size === 0;
        return false;
      }, () => true)).toThrow(/could not restrict peer token/);
      expect(emptyTemporaryFileSeen).toBe(true);
      expect(fs.readFileSync(writeFailure, 'utf8')).toBe(previousPeerBytes);

      const freshPeerFile = getFleetPeerTokenPath(paths, 'A2000');
      expect(() => writeFleetPeerToken(paths, 'A2000', TOKEN, (temporary) => {
        expect(fs.statSync(temporary).size).toBe(0);
        return false;
      }, () => true)).toThrow(/could not restrict peer token/);
      expect(fs.existsSync(freshPeerFile)).toBe(false);
      expect(fs.readdirSync(path.dirname(freshPeerFile)).sort()).toEqual([path.basename(peerFile), path.basename(writeFailure)].sort());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses new fleet report work after shutdown admission stops', async () => {
    getSummary.mockClear();
    stopFleetReadAdmission(server);
    const response = await request('/v1/fleet/summary?range=7d');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'read_unavailable' });
    expect(getSummary).not.toHaveBeenCalled();
  });

});
