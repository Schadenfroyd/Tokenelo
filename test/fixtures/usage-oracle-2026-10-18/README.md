# Usage API oracle fixtures (2026-10-18)

Paired response fixtures for one fabricated snapshot of the Usage API data. They are the committed, reviewable form of what
the real code returns for the cohort in `test/usage-oracle/cohort.ts`, and they are re-verified on every test run.

## Everything here is fabricated

Host labels (`HOST-A`, `HOST-B`), session ids, project paths (`/synthetic/...`), model ids (`oracle-opus`, `oracle-haiku`,
`oracle-gpt`, `oracle-local-27b`, `oracle-unlisted`), token counts, timestamps and the price book are invented.
Nothing was captured from a real tool, ledger, vendor, machine or person. The price book is a small synthetic rate table, not
`rates/prices.json`, and no `MEASURED` label appears anywhere. Dollar figures are API-equivalent list-price arithmetic over the
synthetic book, never an invoice.

## What is in the snapshot

One fixed clock, `2026-10-18T15:30:00.000Z`, calendar day UTC. 29 ledger rows (28 inside the clock, 1 stamped 1 ms after it), 3 sources
(`claude`, `codex`, `ollama-proxy`), 2 hosts, 5 models, 11 sessions in total (counts per range differ). It deliberately contains:

| Case | Cohort rows | Why |
| --- | --- | --- |
| priced (LIST), ESTIMATE-priced, UNPRICED (no price row) | `e01`..`e04`, `e06`; `e05`; `e07`, `e11`, `u01` | unpriced is `null`, not `$0` |
| missing native count (`incomplete`) | `e08` | known categories kept, price withheld |
| conflicting / invalid count evidence | `h02`, `h03` | other unresolved qualities |
| legacy row with no recorded quality | `e10` | reads as `unrecorded`, not `complete` |
| measured zero | `e09` | complete counts that are all zero, priced `$0` |
| local model | `l01`, `l02` | priced `$0` (LIST) |
| records on both sides of every boundary | `b01`..`b09`, `xf1` | start is inclusive; `ts <= clock`; one record after the clock |
| a session spanning ranges, live sessions | `claude-s1` | start/end/tokens differ per range |
| same session id on two hosts | `claude-s1` on `HOST-A` and `HOST-B` | separate rows |
| activity-only session | `claude-idle` | explicit empty feed, not unknown |
| a bucket holding only unpriced events | `u01` (hour), `h02`/`h03` (day) | bucket dollars unavailable, not `$0` |

`cohort.json` lists every row, activity mark and price-book row next to the outputs.

## Files

- `cohort.json` the input table (generated from `test/usage-oracle/cohort.ts`).
- `api/summary-<range>.json`, `api/timeseries-<range>.json`, `api/sessions-<range>.json` for `today`, `24h`, `7d`, `30d`, `all`.
  Read through the daemon's pinned-snapshot path. The timeseries is the bucket the Usage tab pairs with Summary (hours for `today`
  and `24h`, days otherwise), so `summary-X` + `timeseries-X` is one `UsageResponse` pair with one clock and one time basis.
- `api/limits.json` the Claude five-hour block estimates for both hosts, with provider and serving-route evidence kept separate from the stored price-table value. This cohort has no recorded component route, so the fixture marks it `unrecorded`; this is not a claim that the request was routed locally or hosted.

The names are the ones the tray's mock mode reads (`createApiClient({ mockDir, strictMockRanges: true })`). Mock mode also reads
further per-tab files (for example `coverage.json`, `processes.json` and `doctor.json`); this snapshot does not provide
them (see `docs/reviews/2026-10-18-usage-api-oracle/NOTES.md`), so only the tabs backed by the files above can be served from this directory.

This edition reports no valuation. No payload in these files carries a valuation figure, and the Summary `local` block carries the
explicit unavailable comparator values (`usd: null`, `status: "NONE"`). Every new ledger row stores the neutral reserved values (a NULL
value, status `NONE`, an empty definition hash, no rate key); `test/usage-oracle/usage-oracle-queries.test.ts` checks that on the stored
rows. The oracle derives no valuation; everything in these files (events, token counts, count quality, API-equivalent dollars, price
status and evidence, sessions, time basis) is what the real code returns for the cohort.

## How they were generated (no script, only the tests)

Generation is opt-in. From the repository root, with the cloud Node runtime:

```
USAGE_ORACLE_WRITE_FIXTURES=1 node node_modules/vitest/vitest.mjs run -c vitest.cloud.config.ts test/usage-oracle/usage-oracle-fixtures.test.ts
git diff test/fixtures/usage-oracle-2026-10-18
```

A normal run (`node node_modules/vitest/vitest.mjs run -c vitest.cloud.config.ts test/usage-oracle`) never writes: it reads these files and
fails if a live response differs from them, with the fixture name in the message. Review any regenerated diff against the oracle
(`test/usage-oracle/oracle.ts`); the oracle assertions in the other test files do not read these fixtures, so a regenerated file cannot
make a wrong response pass them. Do not edit the JSON by hand.

The tests set `TZ=UTC` for the process because the `today` range starts at local midnight. A separate case switches to `Asia/Kolkata`
to prove the local-midnight rule.

## What these do not show

They do not show native screen rendering, accessibility, real prices, real capture completeness, any invoice, or
anything about an installed package or another host.
