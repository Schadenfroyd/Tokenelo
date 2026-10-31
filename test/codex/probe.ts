/**
 * Read-only real-data probe for the Codex collector (NOT a vitest file). Bundle with
 *   npx esbuild test/codex/probe.ts --bundle --platform=node --format=esm --outfile=<scratch>/codex-probe.mjs
 * and run `node codex-probe.mjs <CODEX_HOME> [sessionIdPrefix …]` on a host. It parses every rollout with the
 * production parser (no ledger writes), opens state_5 / thread_history_1 read-only, and prints ONLY numbers
 * and ids as JSON — never content.
 */
import { performance } from 'node:perf_hooks';
import {
  discoverRollouts,
  parseRolloutFile,
  rawBillable,
  toTokenCounts,
  type CodexFileState,
} from '../../src/collectors/codex.js';
import { CodexSqlite } from '../../src/collectors/codex-sqlite.js';

interface FileRow {
  id: string;
  path: string;
  tree: string;
  bytes: number;
  ms: number;
  state: CodexFileState;
  byModel: Record<string, number>;
  tsSources: Record<string, number>;
  events: number;
}

async function main(): Promise<void> {
  const home = process.argv[2];
  if (!home) throw new Error('usage: codex-probe <CODEX_HOME> [idPrefix…]');
  const focus = process.argv.slice(3);
  const t0 = performance.now();
  const { files, duplicates } = discoverRollouts([home]);
  const db = CodexSqlite.open(home);
  const threads = db.threads();
  const totalsBySession = new Map<string, Set<number>>();
  const rows: FileRow[] = [];
  const modelTotals: Record<string, { billable: number; inputFresh: number; cacheRead: number; cacheWrite5m: number; output: number; reasoning: number; events: number }> = {};
  let bytes = 0;
  let largest = { path: '', bytes: 0, ms: 0 };
  let warnings = 0;
  for (const f of files) {
    const t1 = performance.now();
    const res = await parseRolloutFile(f.path, {
      host: 'probe',
      ...(f.nameId ? { fallbackSessionId: f.nameId } : {}),
      turns: (tid) => (db.hasTurns ? db.turnsFor(tid) : undefined),
      parentTotals: (pid) => totalsBySession.get(pid),
      onWarning: () => {
        warnings++;
      },
    });
    const ms = performance.now() - t1;
    bytes += res.bytesRead;
    if (res.bytesRead > largest.bytes) largest = { path: f.path, bytes: res.bytesRead, ms };
    const sid = res.state.sessionId ?? f.nameId ?? f.path;
    // full totals of this file for the suspect check of later children (probe keeps them all)
    const set = totalsBySession.get(sid) ?? new Set<number>();
    for (const t of res.runTotals) set.add(t);
    totalsBySession.set(sid, set);
    const byModel: Record<string, number> = {};
    const tsSources: Record<string, number> = {};
    for (const u of res.usage) {
      tsSources[u.tsSource] = (tsSources[u.tsSource] ?? 0) + 1;
      for (const c of u.components) {
        const b = rawBillable(c.raw);
        byModel[c.model] = (byModel[c.model] ?? 0) + b;
        const t = toTokenCounts(c.raw).tokens;
        const m = (modelTotals[c.model] ??= { billable: 0, inputFresh: 0, cacheRead: 0, cacheWrite5m: 0, output: 0, reasoning: 0, events: 0 });
        m.billable += b;
        m.inputFresh += t.inputFresh;
        m.cacheRead += t.cacheRead;
        m.cacheWrite5m += t.cacheWrite5m;
        m.output += t.output;
        m.reasoning += t.reasoning;
        m.events += 1;
      }
    }
    rows.push({ id: sid, path: f.path, tree: f.tree, bytes: res.bytesRead, ms, state: res.state, byModel, tsSources, events: res.usage.length });
  }
  // Second pass for the suspect flag needs every file's totals; the parser only kept a 64-entry ring, so
  // re-derive the full sets cheaply from a dedicated pass over files that have a post-turn baseline.
  const postTurn = rows.filter((r) => r.state.summary.firstEventBeforeOwnTurn === false && r.state.summary.baselineTotal > 0);
  const neededParents = new Set(postTurn.map((r) => r.state.meta?.parentThreadId ?? r.state.meta?.forkedFromId).filter((x): x is string => !!x));
  const fullTotals = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!neededParents.has(r.id)) continue;
    const s = new Set<number>();
    const { readLines } = await import('../../src/collectors/codex.js');
    for await (const { line } of readLines(r.path)) {
      const str = line.toString('latin1', 0, Math.min(line.length, 200));
      if (!str.includes('"token_count"')) continue;
      try {
        const o = JSON.parse(line.toString('utf8')) as { payload?: { info?: { total_token_usage?: { total_tokens?: number } } } };
        const t = o.payload?.info?.total_token_usage?.total_tokens;
        if (typeof t === 'number') s.add(t);
      } catch {
        /* ignore */
      }
    }
    fullTotals.set(r.id, s);
  }
  let suspectFull = 0;
  for (const r of postTurn) {
    const pid = r.state.meta?.parentThreadId ?? r.state.meta?.forkedFromId;
    const known = pid ? fullTotals.get(pid) : undefined;
    if (!known || !known.has(r.state.summary.baselineTotal)) suspectFull++;
  }

  const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);
  const S = (r: FileRow) => r.state.summary;
  const tokensUsedSum = sum([...threads.values()], (t) => t.tokensUsed);
  const matchedThreads = rows.filter((r) => threads.has(r.id));

  // Gate 3: root threads, no resets, no baseline, no import, tokens_used > 0.
  const clean = rows.filter((r) => {
    const s = S(r);
    const th = threads.get(r.id);
    return !r.state.meta?.isSubagent && !s.importDetected && s.resets === 0 && s.baselineTotal === 0 && !!th && th.tokensUsed > 0;
  });
  const gate = clean.map((r) => {
    const th = threads.get(r.id)!;
    const s = S(r);
    return {
      id: r.id,
      tokensUsed: th.tokensUsed,
      ownTotalDerived: s.ownTotalDerived,
      ownBillableEmitted: s.ownBillableEmitted,
      lastTotal: s.lastTotal,
      eqDerived: s.ownTotalDerived === th.tokensUsed,
      eqEmitted: s.ownBillableEmitted === th.tokensUsed,
    };
  });
  // deterministic pseudo-random 20 (seeded LCG) so reruns pick the same sample
  let seed = 20260926;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pool = [...gate];
  const sample: typeof gate = [];
  while (pool.length && sample.length < 20) sample.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!);

  const focusRows = rows.filter((r) => focus.some((p) => r.id.startsWith(p)));
  const report = {
    home,
    runtimeMs: Math.round(performance.now() - t0),
    files: rows.length,
    duplicatesSkipped: duplicates.length,
    bytes,
    largest: { ...largest, ms: Math.round(largest.ms) },
    parserWarnings: warnings,
    threadsInDb: threads.size,
    filesMatchedToThreads: matchedThreads.length,
    rawSumTokensUsed_allThreads: tokensUsedSum,
    rawSumLastTotal_files: sum(rows, (r) => S(r).lastTotal ?? 0),
    ownBillableEmitted: sum(rows, (r) => S(r).ownBillableEmitted),
    ownTotalDerived: sum(rows, (r) => S(r).ownTotalDerived),
    baselineTotalExcluded: sum(rows, (r) => S(r).baselineTotal),
    events: sum(rows, (r) => r.events),
    byModel: modelTotals,
    counts: {
      filesWithResets: rows.filter((r) => S(r).resets > 0).length,
      resetEvents: sum(rows, (r) => S(r).resets),
      resetLastMismatch: sum(rows, (r) => S(r).resetLastMismatch),
      filesPreTurnBaseline: rows.filter((r) => S(r).firstEventBeforeOwnTurn === true && S(r).baselineTotal > 0).length,
      filesPreTurnBaselineBillable: rows.filter((r) => S(r).firstEventBeforeOwnTurn === true && S(r).baselineBillable > 0).length,
      filesPostTurnBaseline: postTurn.length,
      // first event zeroed although it sits in a newer-than-thread UUIDv7 turn (turn_context-only own turn?)
      preTurnButNewerUuidTurn: rows.filter((r) => S(r).firstEventBeforeOwnTurn === true && S(r).firstEventInNewerUuidTurn === true).length,
      preTurnButNewerUuidTurn_firstLastBillable: sum(rows.filter((r) => S(r).firstEventBeforeOwnTurn === true && S(r).firstEventInNewerUuidTurn === true), (r) => S(r).firstLastBillable),
      preTurnButNewerUuidTurn_noBaseline: rows.filter((r) => S(r).firstEventBeforeOwnTurn === true && S(r).firstEventInNewerUuidTurn === true && S(r).baselineBillable === S(r).firstLastBillable && S(r).firstLastBillable > 0).length,
      preTurnFiles_firstLastBillable: sum(rows.filter((r) => S(r).firstEventBeforeOwnTurn === true), (r) => S(r).firstLastBillable),
      filesSuspect_parser: rows.filter((r) => S(r).inheritedBaselineSuspect).length,
      filesSuspect_fullParentTotals: suspectFull,
      filesWithRecords: rows.filter((r) => S(r).records > 0).length,
      filesRecordReconciled: rows.filter((r) => S(r).recordEvents > 0).length,
      records: sum(rows, (r) => S(r).records),
      recordDuplicates: sum(rows, (r) => S(r).recordDuplicates),
      recordMismatchEvents: sum(rows, (r) => S(r).recordMismatches),
      filesWithRecordMismatch: rows.filter((r) => S(r).recordMismatches > 0).length,
      recordFreeDeltas: sum(rows, (r) => S(r).recordFreeDeltas),
      filesWithRecordFreeDeltas: rows.filter((r) => S(r).recordFreeDeltas > 0).length,
      pendingRecordsAtEof: sum(rows, (r) => r.state.pending.length),
      filesPendingAtEof: rows.filter((r) => r.state.pending.length > 0).length,
      recordFiles_recordTotal_vs_derived_equal: rows.filter((r) => S(r).records > 0 && S(r).recordTotal === S(r).ownTotalDerived).length,
      fieldDecreaseEvents: sum(rows, (r) => S(r).fieldDecreases),
      filesFieldDecrease: rows.filter((r) => S(r).fieldDecreases > 0).length,
      nonZeroCacheWrite: sum(rows, (r) => S(r).nonZeroCacheWrite),
      replayEvents: sum(rows, (r) => S(r).replayEvents),
      olderTurnEvents: sum(rows, (r) => S(r).olderTurnEvents),
      filesWithOlderTurnEvents: rows.filter((r) => S(r).olderTurnEvents > 0).length,
      filesWithReplayEvents: rows.filter((r) => S(r).replayEvents > 0).length,
      replayExcludedTotal: sum(rows, (r) => S(r).replayExcludedTotal),
      recordsForeignThread: sum(rows, (r) => S(r).recordsForeignThread),
      recordsInReplay: sum(rows, (r) => S(r).recordsInReplay),
      imports: rows.filter((r) => S(r).importDetected).length,
      eventsWithoutModel: sum(rows, (r) => S(r).eventsWithoutModel),
      filesMissingOrdinals: rows.filter((r) => S(r).missingOrdinals > 0).length,
      subagentFiles: rows.filter((r) => r.state.meta?.isSubagent).length,
      tsSources: rows.reduce<Record<string, number>>((a, r) => {
        for (const [k, v] of Object.entries(r.tsSources)) a[k] = (a[k] ?? 0) + v;
        return a;
      }, {}),
      subagentTsSources: rows.filter((r) => r.state.meta?.isSubagent).reduce<Record<string, number>>((a, r) => {
        for (const [k, v] of Object.entries(r.tsSources)) a[k] = (a[k] ?? 0) + v;
        return a;
      }, {}),
    },
    gate3: {
      cleanRoots: gate.length,
      eqDerived: gate.filter((g) => g.eqDerived).length,
      eqEmitted: gate.filter((g) => g.eqEmitted).length,
      mismatches: gate.filter((g) => !g.eqDerived || !g.eqEmitted).slice(0, 25),
      sample20: sample,
    },
    mismatchRecordFiles: rows.filter((r) => S(r).recordMismatches > 0).slice(0, 15).map((r) => ({ id: r.id, ...pick(S(r)) })),
    preTurnNewerUuidExamples: rows.filter((r) => S(r).firstEventBeforeOwnTurn === true && S(r).firstEventInNewerUuidTurn === true).slice(0, 10).map((r) => ({ id: r.id, kind: r.state.meta?.sourceKind, cli: r.state.meta?.cliVersion, firstLast: S(r).firstLastBillable, baseline: S(r).baselineBillable, records: S(r).records, recordTotal: S(r).recordTotal, own: S(r).ownBillableEmitted, tokensUsed: threads.get(r.id)?.tokensUsed })),
    topNoModel: rows.filter((r) => S(r).eventsWithoutModel > 0).sort((a, b) => S(b).eventsWithoutModel - S(a).eventsWithoutModel).slice(0, 12).map((r) => ({ id: r.id, n: S(r).eventsWithoutModel, cli: r.state.meta?.cliVersion, sub: r.state.meta?.isSubagent, kind: r.state.meta?.sourceKind })),
    topFrozen: rows.filter((r) => (r.tsSources['frozen-line'] ?? 0) > 0).sort((a, b) => (b.tsSources['frozen-line'] ?? 0) - (a.tsSources['frozen-line'] ?? 0)).slice(0, 12).map((r) => ({ id: r.id, n: r.tsSources['frozen-line'], all: r.events, cli: r.state.meta?.cliVersion, kind: r.state.meta?.sourceKind })),
    frozenFiles: rows.filter((r) => (r.tsSources['frozen-line'] ?? 0) > 0).length,
    freeDeltaFiles: rows.filter((r) => S(r).recordFreeDeltas > 0).slice(0, 15).map((r) => ({ id: r.id, ...pick(S(r)) })),
    focus: focusRows.map((r) => ({
      id: r.id,
      tree: r.tree,
      bytes: r.bytes,
      ms: Math.round(r.ms),
      meta: r.state.meta ? { ...r.state.meta, cwd: undefined } : undefined,
      tokensUsed: threads.get(r.id)?.tokensUsed ?? null,
      events: r.events,
      byModel: r.byModel,
      tsSources: r.tsSources,
      pendingAtEof: r.state.pending.length,
      summary: S(r),
    })),
  };
  db.close();
  process.stdout.write(JSON.stringify(report, null, 1) + '\n');
}

function pick(s: CodexFileState['summary']) {
  return {
    records: s.records,
    recordEvents: s.recordEvents,
    recordMismatches: s.recordMismatches,
    recordFreeDeltas: s.recordFreeDeltas,
    recordTotal: s.recordTotal,
    ownTotalDerived: s.ownTotalDerived,
    ownBillableEmitted: s.ownBillableEmitted,
    resets: s.resets,
    baselineTotal: s.baselineTotal,
    firstEventBeforeOwnTurn: s.firstEventBeforeOwnTurn,
  };
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
