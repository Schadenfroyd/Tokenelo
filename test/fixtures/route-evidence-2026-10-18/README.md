# Route-evidence fixtures (fabricated)

Follow-up to decision **D4** in `docs/cloud/CLAUDE-INBOX-2026-10-17.md` ("add falsifiable route fixtures before
proposing implementation"). The directory holds a small synthetic fixture set for the six route states the code
distinguishes (`src/core/serving-route.ts`): `local-reported`, `hosted-reported`, `unrecorded`, `unknown`, `invalid`,
`conflict`.

**Everything here is fabricated.** The numbers are round counts, the model ids are made up (`qwen3:8b` and
`qwen/qwen3-coder-fabricated` only match a local weights family by name), and there are no prompts, responses,
filesystem paths, hostnames, credentials, account identifiers or captured data. Nothing was read from a ledger, a
vendor or a running engine. These files are not telemetry, not release evidence and not a price or calibration claim.

## Files and what each one is

| File | Label | Read by a test? |
| --- | --- | --- |
| `components.json` | Inputs: 12 fabricated usage components, two or more variants per state where the code has several shapes (for example five distinct `invalid` shapes). `unrecorded` means the `servingRoute` key is absent; every other state has the key present (a `null` value is the `invalid-null` case). | Yes: `test/core/route-evidence-fixtures.test.ts` |
| `current-behavior.json` | **CURRENT BEHAVIOR.** What the code classifies today for each input: route state, whether the local rate policy is admitted, provider, component price, and what the ledger stores (provider, amount, price status, route flags). Derived by hand from `serving-route.ts`, `pricing.ts` and `ledger.ts`, then confirmed by the passing test. | Yes, asserted |
| `target-d4-classification.json` | **TARGET (proposal for owner review).** What decision D4 would require for the same inputs: a new `unrecorded` route stays provider-unknown and unpriced; the other states do not change. Also lists open questions that D4 leaves undecided. Only the two `unrecorded` cases differ from current behavior (`changesFromCurrent: true`). | **No.** No test reads or asserts it. Today's code does not meet it. |

The target file exists so that a later implementation can be proven against concrete cases. It is not a decision and
it is not an implementation. Adding an asserting test for it is the owner's step, after reviewing the open questions.

## What the current-behavior test proves, and does not

It proves that each fixture reaches the real code paths (route state, `pricing.priceComponent`, `pricing.providerOf`,
the ledger's stored provider/amount/status/flags), and that the labelled states are the states the code reports.
Two cases are labelled `[pins current legacy policy]`: a hosted-looking weights name with no route evidence is still
priced as free local work today, and an event built by the metering proxy carries no `servingRoute` key. Those two
assertions are today's policy, not a requirement; change them together with the D4 implementation.

It does **not** prove that any state is correct, that `metered-engine` is evidence of a real local engine (the type
comment says it is a policy slot, not an attestation), that any real hosted endpoint behaves like these inputs, that
any price or calibration is right, or anything about the stored rows of a real ledger. The reserved valuation
columns of already-stored rows are untouched by design: ordinary replay keeps them (see
`test/store/neutral-valuation-ledger.test.ts`).
An explicit `undefined` route value cannot be written in JSON; it is covered in code by
`test/core/route-policy.test.ts` and `test/store/` route tests.

## Open question surfaced while building this

The metering proxy is the main local capture path and its events carry no route evidence. If D4 is implemented as
"unrecorded stays unpriced", new proxy events would stop receiving the local rate unless the proxy stamps affirmative
local evidence. See `openQuestions` in `target-d4-classification.json`. The owner decides; this branch changes no source.
