/**
 * Shared test harness for the Usage API oracle: builds the cohort ledger, the real queries (in-memory path and the
 * daemon's pinned-snapshot path), an in-process loopback HTTP server over the real handler, and the fixture IO.
 * Fabricated data only; no network beyond 127.0.0.1; temporary files live under the OS temp dir and are removed.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { openDb, openLedgerReadOnly, type TokeneloDb } from '../../src/store/db.js';
import { createQueries, type CreateQueriesOpts, type Queries } from '../../src/store/queries.js';
import { closeHttpReads, createHttpServer } from '../../src/daemon/http.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { Range, TokeneloConfig, UsageResponse } from '../../src/core/types.js';
import { HOST_A, NOW, buildEngines, seedCohort } from './cohort.js';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usage-oracle-2026-10-18');
export const API_FIXTURE_DIR = path.join(FIXTURE_DIR, 'api');

export const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });
const noProcesses: NonNullable<CreateQueriesOpts['listProcesses']> = async () => [];

export interface Cohort { db: TokeneloDb; queries: Queries; config: TokeneloConfig; engines: ReturnType<typeof buildEngines>; close(): void }

function queriesFor(db: TokeneloDb, config: TokeneloConfig, engines: Cohort['engines'], extra: Partial<CreateQueriesOpts> = {}): Queries {
  return createQueries(db, config, { now: () => NOW, pricing: engines.pricing, probeOllama: stubProbe, listProcesses: noProcesses, ...extra });
}

/** The cohort in an in-memory ledger, read through the synchronous path (what the CLI uses). */
export function openMemoryCohort(): Cohort {
  const engines = buildEngines();
  const db = openDb({ file: ':memory:' });
  seedCohort(db, engines);
  const config = defaultConfig({ hostLabel: HOST_A });
  return { db, queries: queriesFor(db, config, engines), config, engines, close: () => db.close() };
}

export interface FileCohort extends Cohort {
  /** Runs `fn` with queries over a fresh pinned read-only snapshot, exactly as daemon/report-worker.ts does, then rolls back. */
  withSnapshot<T>(fn: (q: Queries) => Promise<T>): Promise<T>;
  /** The daemon's wiring: report reads go through a pinned snapshot; Limits, Coverage and Processes use the writable handle. */
  daemonQueries(): Queries;
}

export function openFileCohort(): FileCohort {
  const engines = buildEngines();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-usage-oracle-'));
  const file = path.join(dir, 'ledger.db');
  const db = openDb({ file });
  seedCohort(db, engines);
  const config = defaultConfig({ hostLabel: HOST_A });
  const writable = queriesFor(db, config, engines);
  async function withSnapshot<T>(fn: (q: Queries) => Promise<T>): Promise<T> {
    const ro = openLedgerReadOnly(file, { snapshot: true });
    try {
      ro.exec('PRAGMA query_only=ON');
      return await fn(queriesFor(ro, config, engines, { readSnapshotDb: ro, fixedSessionReportAsOf: NOW }));
    } finally {
      try { ro.exec('ROLLBACK'); } finally { ro.close(); }
    }
  }
  const daemonQueries = (): Queries => {
    const getUsage = (range: Range) => withSnapshot((q) => usagePair(q, range));
    return { ...writable,
      getSummary: (range) => withSnapshot((q) => q.getSummary(range)),
      getSessions: (o) => withSnapshot((q) => q.getSessions(o)),
      getTimeseries: (bucket, range) => withSnapshot((q) => q.getTimeseries(bucket, range)),
      getUsage, getUsageReport: getUsage, getSummaryReport: (range) => withSnapshot((q) => q.getSummary(range)) };
  };
  return { db, queries: writable, config, engines, withSnapshot, daemonQueries,
    close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The unified Usage pair, composed exactly as daemon/report-worker.ts composes the 'usage' task (one transaction, one clock). */
export async function usagePair(q: Queries, range: Range): Promise<UsageResponse> {
  const summary = await q.getSummary(range);
  const timeseries = await q.getTimeseries(range === 'today' || range === '24h' ? 'hour' : 'day', range);
  return { snapshotScope: 'shared-read-transaction', summary, timeseries };
}

export const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── loopback HTTP over the real handler ─────────────────────────────────────────────────────────────────────
export const API_TOKEN = 'usage-oracle-test-token-0000000000000000';
export async function startServer(queries: Queries): Promise<{ base: string; port: number; get(pathAndQuery: string): Promise<{ status: number; body: any }>; close(): Promise<void> }> {
  const opts = { port: 0, token: API_TOKEN, queries, host: HOST_A };
  const server: http.Server = createHttpServer(opts);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  opts.port = (server.address() as import('node:net').AddressInfo).port;
  const base = `http://127.0.0.1:${opts.port}`;
  return {
    base, port: opts.port,
    get: async (p) => { const res = await fetch(base + p, { headers: { Authorization: `Bearer ${API_TOKEN}` } }); return { status: res.status, body: await res.json() }; },
    close: async () => { await closeHttpReads(server); await new Promise<void>((ok) => server.close(() => ok())); },
  };
}

// ── golden fixtures ─────────────────────────────────────────────────────────────────────────────────────────
export function readFixture<T = any>(relative: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, relative), 'utf8')) as T;
}
/**
 * Compares a live response with its committed fixture. The fixtures are only ever written when
 * USAGE_ORACLE_WRITE_FIXTURES=1 is set explicitly (see the fixture README); a normal run never writes and fails on drift.
 */
export function checkFixture(relative: string, actual: unknown): void {
  const normalized = JSON.parse(JSON.stringify(actual)) as unknown;
  const file = path.join(FIXTURE_DIR, relative);
  if (process.env.USAGE_ORACLE_WRITE_FIXTURES === '1') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n');
  }
  expect(fs.existsSync(file), `missing fixture ${relative}; generate it as described in the fixture README`).toBe(true);
  expect(normalized, `response drifted from fixture ${relative}; if the change is intended, regenerate and review the diff (see README)`).toEqual(readFixture(relative));
}
