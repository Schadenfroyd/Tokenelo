# Fabricated price tables for the price-history tests

Everything in this directory is invented for tests. Nothing is a vendor price, an invoice, a measurement or a copy
of `rates/prices.json`.

| File | What it is |
| --- | --- |
| `prices-old.json` | A pinned "older" price table, eight rows (every `synth-*` id, rate, date and source string is fabricated) |
| `prices-today.json` | A "later" table: hosted and comparator-style rates changed and one model (`synth-new-model`) was added |

`test/helpers/price-history-world.ts` loads both tables and pins their price-table versions as literals;
`test/store/price-history-ledger.test.ts` fails if a file here drifts from them. Editing a table therefore needs a
deliberate update of those literals and of the hand-computed numbers in the test comments.

| Pinned value | sha256 |
| --- | --- |
| old price table version | `e357da3f1675c3cd9eabffe064dd82a562113816cc3fd13d4b517a1750d06ccd` |
| today price table version | `6f40d1cf2ee3096201ed9cb1385884561fbf6be87e5166777ab20b89dab73578` |

## The rate card the hand arithmetic uses ($ per million tokens)

Columns are input / 5-minute cache write / 1-hour cache write / cache read / output.

| Row | Old | Today |
| --- | --- | --- |
| `synth-hosted` standard | 2 / 2.5 / 4 / 0.2 / 10 | 3 / 3.75 / 6 / 0.3 / 15 |
| `synth-hosted` fast (LIST) | 4 / 5 / 8 / 0.4 / 20 | 6 / 7.5 / 12 / 0.6 / 30 |
| `synth-hosted` ultrafast (ESTIMATE) | 6 / 7.5 / 12 / 0.6 / 30 | 9 / 11.25 / 18 / 0.9 / 45 |
| `synth-hosted` US residency multiplier | 1.1 | 1.1 |
| `synth-derived` (1h write column derived, so billing it is ESTIMATE) | 1 / 1.25 / 2 / 0.1 / 5 | same |
| `synth-estimate-row` (row status ESTIMATE) | 1 / 1.25 / 2 / 0.1 / 5 | same |
| `synth-long` (whole request at the bracket above 100,000 input-side tokens) | 2 / 2.5 / 2.5 / 0.2 / 10, bracket 4 / 5 / 5 / 0.4 / 15 | same |
| `synth-local-a`, `synth-local-b` (local weights rows) | 0 / 0 / 0 / 0 / 0 | same |
| `synth-cmp-a` (hosted) | 2 / 2.5 / 4 / 0.2 / 10 | 4 / 5 / 8 / 0.4 / 20 |
| `synth-cmp-b` (hosted) | 4 / 5 / 5 / 0.4 / 20 | 2 / 2.5 / 2.5 / 0.2 / 10 |
| `synth-new-model` | no row (unpriced) | 1 / 1.25 / 2 / 0.1 / 5 |

## What these files do not do

They do not model any real model, vendor, bill, served tier, hardware or run. They do not establish that the shipped
price table is right. Hand-computed expectations in the tests are derived from this card, never read back from the
code under test.
