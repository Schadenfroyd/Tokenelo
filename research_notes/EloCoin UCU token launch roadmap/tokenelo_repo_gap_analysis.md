# Tokenelo repo state, UCU definition, and gap analysis for an "EloCoin" (ELO) AI-compute token

Scope: internal codebase research only, covering every tracked file in `/home/user/Tokenelo` at `main` = `30a5cea` (2026-10-07), plus git history and the two remote PR refs (`refs/pull/1/head` = `daf9024` and `refs/pull/2/head` = `28ac22f`, both tree-identical to the merged main commits). Citations are GitHub permalinks at commit `30a5cea` with line anchors, and they match the local files line for line. No web research was done.

Repo inventory: 3 commits, all on 2026-10-07 by GitHub user `Schadenfroyd` (`71200b6` Initial commit, `0bddb89` Build the Tokenelo public project foundation, `30a5cea` Record approved Apache-2.0 licensing plan). Tracked files: README, CHANGELOG, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, `docs/{data-accuracy,licensing,privacy,roadmap,trademarks}.md`, `.github/` issue and PR templates, Dependabot, one CI workflow, and one script (`scripts/check-docs.mjs`, a Markdown local-link checker). **There is no product source code, no tests, no UCU formula, no data and no license file in the repo.**

---

## 1. What is Tokenelo today: product, status, license, roadmap?

### Takeaway
Tokenelo is positioned as a **free, local-first AI token *usage tracker* for vendor accountability** (engineering, procurement and FinOps). It is at **"internal alpha"** with **no public source, binary or license yet**. Apache-2.0 is the "approved licensing plan" but has not been granted. The public repo is docs-only scaffolding. UCU was deliberately demoted from the original raison d'être ("toward UCU computation") to a "secondary measurement feature".

### Cited Findings
**Product and positioning**
- Tagline: "**Free AI token tracking and reporting, built for vendor accountability.**" ([README.md#L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L3))
- Audience and purpose: "Tokenelo helps engineering, procurement, and FinOps teams understand recorded AI usage: which tools and models were used, how token counts were reported, and what evidence supports a total." ([README.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L5))
- "Track locally. Inspect the breakdown. Take a clear report into your next vendor conversation." ([README.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L7))
- The feature table covers per-source/model/session token components, drill-down to normalized records, "Versioned API-equivalent price comparisons", "Local JSON and CSV reporting", and "Coverage and diagnostic views". ([README.md#L13-L19](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L13-L19))
- Sources: "Tokenelo's internal implementation includes adapters for Claude Code, Codex, and configured local inference, plus selected tool metadata. Availability depends on source records and configuration." ([README.md#L27](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L27))
- Internal architecture as described: "local authenticated read API, guarded Electron IPC and local storage. Optional fleet access and local metering proxies require deliberate configuration." ([SECURITY.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L15)) Storage is "a local SQLite ledger" ([docs/privacy.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L7)), and the "internal daemon's local read API uses bearer authentication and a loopback listener" ([docs/privacy.md#L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L13)).
- Owner: "Built by Elo AI." ([README.md#L47](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L47)) and "Tokenelo is an Elo AI project." ([docs/trademarks.md#L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/trademarks.md#L3)) "This document does not assert trademark registration" ([docs/trademarks.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/trademarks.md#L5)).

**Status (exact phrasing)**
- "> **Release status:** internal alpha; public source release is being prepared. This repository currently hosts the project overview and release plan. An open-source license and downloadable release have not yet been issued. The free tracker is the primary product; UCU is a secondary measurement feature." ([README.md#L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L9))
- "## Unreleased — public release preparation" … "No public source or binary version has been released. Internal engineering history is not represented as a public release history." ([CHANGELOG.md#L3-L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CHANGELOG.md#L3-L9))
- "No public source or binary release is currently supported. The project is preparing an alpha release." ([SECURITY.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L5))
- The commit body of `0bddb89` reads: "Free token-tracking positioning, product trust documentation and safe repository scaffolding. **No private product source, UCU methods, captured data or license grant.**" ([commit 0bddb89](https://github.com/Schadenfroyd/Tokenelo/commit/0bddb89))

**License**
- "The tracker source and an open-source license have not yet been published." ([docs/licensing.md#L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L3))
- "Apache-2.0 is the approved licensing plan for the cleared tracker contribution, including original documentation and synthetic examples, with third-party notices preserved. The final license must identify the actual licensor and match the reviewed release scope. Source publication and the license grant remain pending clearance; this document is not a license grant." ([docs/licensing.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L5)). Commit `30a5cea` changed this from "The proposed license is Apache-2.0" to "approved licensing plan" ([commit 30a5cea](https://github.com/Schadenfroyd/Tokenelo/commit/30a5cea)).
- "Until then, do not treat the absence of a license as open-source permission." ([docs/licensing.md#L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L9))
- The proposed contribution policy is DCO sign-off, "not copyright assignment" ([CONTRIBUTING.md#L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L13)).

**Roadmap** ([docs/roadmap.md](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md))
- "The free tracker and dependable reports are the priority. This is a plan, not a promise of delivery dates." ([L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L3))
- Public alpha has 7 items, **all unchecked**: publish source inventory and license; clean build and test on every platform; document adapters and coverage limits; verify drill-downs, subagent inclusion and unknown-data states; CSV/JSON field dictionary; privacy, dependency notices and vulnerability reporting; DB migration, backup and rollback. ([L7-L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L7-L13))
- Reporting depth (all unchecked): share-safe redacted report; "Explore vendor invoice/rate-card comparison"; source freshness; incomplete-count explanations. ([L17-L20](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L17-L20))
- Secondary measurement: "Publish only the reviewed UCU scope with versioned definitions and calibration qualifications." and "Keep token reporting understandable without knowledge of UCU." ([L24-L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L24-L25))
- Release acceptance: "No signed installer, supported hosted service, billing certification or financial return is claimed until its evidence exists." ([L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29))
- **There is no EloCoin, token or crypto item anywhere on the roadmap.**

**Positioning history**
- The initial-commit README was a single line: "Tokenelo is used to track AI token-based activity toward UCU computation." ([commit 71200b6](https://github.com/Schadenfroyd/Tokenelo/commit/71200b6)). Commit `0bddb89` replaced it with the free-tracker-first README ([commit 0bddb89](https://github.com/Schadenfroyd/Tokenelo/commit/0bddb89)).
- CHANGELOG: "Established the free token-tracking and vendor-accountability positioning." ([CHANGELOG.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CHANGELOG.md#L5))

### Inferences
- Within one day (2026-10-07) the project pivoted its public story from "UCU computation" to "free tracker, UCU secondary". The public docs were written to *distance* the tracker from UCU monetization and from EloCoin. An EloCoin launch would work against this deliberate repositioning unless it is kept organizationally separate.
- With no source, tests or license, nothing in the public repo can currently be audited. Any token claim of "open, verifiable measurement" has no public artifact behind it today.
- "The final license must identify the actual licensor" suggests the legal entity that owns Tokenelo IP is not yet settled. A token issuer would need this settled first.

### Gaps
- Internal implementation details (languages, adapter code, schema, UCU code) are not in the repo. The commit message states they were withheld intentionally.
- No dates, milestones, team, funding or legal entity details (beyond the name "Elo AI") appear anywhere.
- The repo does not state whether "Elo AI" is incorporated, or in which jurisdiction.

---

## 2. What exactly is a UCU: formula, inputs, calibration, uncertainty, versioning, and how is it earned?

### Takeaway
**The repo contains no UCU formula, input list, calibration data, uncertainty figures or even an expansion of the acronym "UCU".** It describes UCU only as a "secondary, versioned compute-measurement feature under review" with a "definition/rate identity" and a "calibration qualification" whose "uncertainty and calibration status must be visible". UCU methods were explicitly withheld from the public commit. **There is no earning or accrual mechanism**: the docs expressly say UCU establishes no cash balance, token issuance, redemption or financial return, and that the tracker has no reward mechanism.

### Cited Findings
- Full public definition: "UCU is a secondary, versioned compute-measurement feature under review. Its uncertainty and calibration status must be visible. It does not establish output quality, a cash balance, token issuance, redemption, or a financial return. Public methodology/source scope is still being reviewed." ([README.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L37))
- "UCU has a separate definition/rate identity and calibration qualification. Count completeness, pricing status and UCU calibration are separate questions." ([docs/data-accuracy.md#L21](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L21))
- Versioning and calibration are a pending deliverable: "Publish only the reviewed UCU scope with versioned definitions and calibration qualifications." ([docs/roadmap.md#L24](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L24))
- "UCU methodology is a secondary release-scope consideration." ([docs/licensing.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L7)). It may not be covered by the Apache-2.0 tracker release.
- The public commit excluded "UCU methods" ([commit 0bddb89](https://github.com/Schadenfroyd/Tokenelo/commit/0bddb89)).
- Contributors must keep "UCU secondary to the tracking workflow" ([CONTRIBUTING.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L15)).
- Original framing: "track AI token-based activity toward UCU computation" ([commit 71200b6](https://github.com/Schadenfroyd/Tokenelo/commit/71200b6)).
- **Likely inputs (the token components the tracker records):** "Fresh input, cache creation, cache reads, output and reasoning are distinct fields. Some providers report cache creation by duration; others leave it unspecified." ([docs/data-accuracy.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L7)) "Reasoning can be a subset of output… Do not add subsets again when calculating a total." ([L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L9)) Records also carry source, model, provider, session and host metadata ([docs/privacy.md#L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L9)).
- Rate provenance is recorded per row: CSV v2 "adds token components, qualifications, source/model-component detail and rate provenance" ([docs/data-accuracy.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L25)). The repo does not say whether "rate" here means price rate, UCU rate or both.
- Energy is mentioned only for cost: "Local inference comparison is also not a paid amount. Electricity estimates require explicit assumptions." ([docs/data-accuracy.md#L19](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L19))
- **There is no mention of FLOPs, GPU-hours, hardware type, latency, energy-per-token or any physical compute basis** (grep over all tracked files).
- **Earning or accrual:** "The planned local tracker requires no Tokenelo account, paid subscription, crypto wallet, or reward mechanism." ([README.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L25))

### Inferences
- "Definition/rate identity" implies UCU = Σ (token component count × a versioned per-model/per-component rate). In other words, a **conversion of *reported tokens* into a normalized unit**, not a direct measurement of physical compute. If so, UCU inherits every token-count quality problem in Section 4, plus model-to-model rate-calibration uncertainty. (This is inference from wording only; the formula is not public.)
- Because the tracker records tokens a user *consumes* via vendor tools, UCU as described measures **demand-side consumption** of AI compute, not **supply-side provision**. A commodity token "representing compute" more naturally maps to redeemable or deliverable compute, which UCU does not describe. Rewarding consumption with a tradeable coin would pay users to burn tokens (a wash-usage incentive).
- "Calibration qualification" and visible "uncertainty" suggest UCU values carry error bars or quality flags. A fungible coin needs a single settled quantity, so a rule for turning qualified or uncertain measurements into a finalized mint amount would have to be designed.

### Gaps
- The UCU acronym expansion, formula, unit basis, rate tables, calibration method, reference hardware or model, uncertainty magnitudes and version scheme: **none are in the repo**. All appear to live in withheld internal source.
- Whether UCU is computed for local-inference sources differently (e.g., hardware or energy based) versus vendor API sources cannot be determined.

---

## 3. Explicit disclaimers and commitments that conflict with a token, and what would have to change

### Takeaway
The public docs contain at least 15 explicit statements that disclaim financial value, token issuance, rewards, wallets, audits, billing-grade accuracy and hosted services. One states outright: "**EloCoin is a separate product pursuit and is not part of the tracker launch.**" The cleanest path is to **leave these tracker disclaimers intact** and launch EloCoin as a legally and organizationally separate product with its own methodology, terms and governance. Deleting them would undercut the trust-and-accountability positioning the repo was just built around.

### Cited Findings: disclaimer register

| # | File:line | Exact text (abridged only where marked …) | Conflict with a token | What would have to change |
|---|---|---|---|---|
| 1 | [README.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L37) | "It does not establish output quality, a cash balance, token issuance, redemption, or a financial return." | Direct negation of a UCU-backed token: issuance, redemption and financial return. | Either keep it true for Tokenelo-UCU and define a *separate* EloCoin unit and issuer, or rewrite it. Rewriting reverses a published commitment and needs legal review. |
| 2 | [README.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L25) | "The planned local tracker requires no Tokenelo account, paid subscription, crypto wallet, or reward mechanism. It is intended to remain useful on its own. Optional future hosted services would have separate terms; no paid service is announced here." | A token earned via the tracker would add a wallet and a reward mechanism. | Compatible only if EloCoin is an *optional, separate* hosted service "with separate terms", and the tracker still works with no wallet. The doc already leaves room for "separate terms". |
| 3 | [docs/licensing.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L7) | "UCU methodology is a secondary release-scope consideration. EloCoin is a separate product pursuit and is not part of the tracker launch." | Repo-level separation of EloCoin from Tokenelo. | Consistent with a separate EloCoin repo or entity. Any EloCoin dependence on Tokenelo data must be documented as a separate data flow. |
| 4 | [README.md#L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L9) | "The free tracker is the primary product; UCU is a secondary measurement feature." | A token would make UCU economically primary. | Reposition UCU, or move it into a separate methodology spec owned by EloCoin governance. |
| 5 | [CONTRIBUTING.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L15) | "Keep UI language concise, navigation consistent, and UCU secondary to the tracking workflow." | Contribution policy blocks UCU-first or token UI in the tracker. | Keep token UI out of the tracker. Change policy only if the tracker is to host it. |
| 6 | [CONTRIBUTING.md#L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L17) | "Maintainers may request revision or decline work that changes the free local tracking commitment." | A token that requires uploads or accounts would change this commitment. | Keep the local tracker free. Put the token integration in an opt-in plugin or service. |
| 7 | [docs/roadmap.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L25) | "Keep token reporting understandable without knowledge of UCU." | Same as #4. | Same as #4. |
| 8 | [docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29) | "No signed installer, supported hosted service, billing certification or financial return is claimed until its evidence exists." | A token implies financial return, a hosted service and a signed client. | Produce the evidence (signed builds, hosted service, certification) *before* any claim. |
| 9 | [README.md#L21](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L21) | "**Recorded usage is evidence, not an invoice.** Plan quotas, negotiated rates, discounts, rounding, and activity outside the captured sources can differ from a vendor bill. Unknown or missing data must stay visible." | Minting needs settlement-grade quantities, but the tracker says its data is not invoice-grade. | Mint from verified sources (vendor-signed usage or invoices) rather than recorded local evidence. |
| 10 | [docs/data-accuracy.md#L19](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L19) | "API-equivalent cost … does not establish an invoice, subscription allocation, refund entitlement, negotiated price or actual cash savings. Local inference comparison is also not a paid amount." | Any USD peg or valuation of UCU via API-equivalent price is disclaimed. | A token valuation method separate from "API-equivalent" pricing, or a new disclosure. |
| 11 | [docs/data-accuracy.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L37) | "Automated invoice reconciliation is a proposed feature, not a released capability." | No automated tie-out to vendor bills, which is the main anti-fraud check available. | Build and ship reconciliation (roadmap L18) before using it to verify mints. |
| 12 | [SECURITY.md#L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L17) | "Local administrator access, a compromised account and a malicious upstream remain outside the protection offered by token accounting. Security review is ongoing; no external audit or compliance certification is claimed." | The tracker's threat model excludes the user, yet the user is the main adversary once usage mints money. | New threat model with the user as adversary, external security audit, and any applicable compliance certifications. |
| 13 | [SECURITY.md#L11](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L11) | "Maintainers will assess reports as capacity permits; no remediation SLA is promised." | Financial systems need incident-response commitments. | A defined SLA and bug bounty for EloCoin components. |
| 14 | [docs/privacy.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L25) | "No central analytics collection or hosted account requirement is announced. Any future telemetry, hosted fleet administration, or report upload needs explicit configuration, a documented data inventory and its own retention/access policy." | A token needs usage upload and accounts. | Explicit opt-in, data inventory, retention and access policy, and privacy notice for EloCoin uploads. Note the conflict between KYC data retention and the "metadata is sensitive" stance ([README.md#L31](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L31)). |
| 15 | [docs/privacy.md#L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L3), [#L21](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L21) | "This is a product data-handling description, not a contract for a hosted service." / "No automatic retention period or certified data-erasure guarantee is claimed now." | Token operations need contractual terms and retention rules. | Terms of service and a privacy policy for the token service. |
| 16 | [README.md#L47](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L47); [docs/trademarks.md#L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/trademarks.md#L3), [#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/trademarks.md#L7) | "Vendor and product names identify supported sources; they do not imply endorsement." / "Do not imply that Elo AI endorses a modified product, vendor, service or report." | A coin "representing compute" from Claude, Codex and similar tools risks implying vendor backing. | Marketing must avoid implied vendor endorsement. Vendor terms on usage-data use should be reviewed (not in repo). |
| 17 | [CHANGELOG.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CHANGELOG.md#L5); [.github/PULL_REQUEST_TEMPLATE.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/.github/PULL_REQUEST_TEMPLATE.md#L15) | "Established the free token-tracking and vendor-accountability positioning." / "UI copy and navigation are consistent with the free tracking workflow." | Positioning lock-in. | A new positioning decision, if the tracker is to front a token. |
| 18 | [docs/roadmap.md#L3](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L3); [CONTRIBUTING.md#L19](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L19) | "This is a plan, not a promise of delivery dates." / "No response-time guarantee or support contract is offered through public issues." | Token holders would rely on delivery commitments. | Formal disclosures and governance for the token. |

### Inferences
- Disclaimers #1, #2, #3 and #14 are consistent with a **two-entity or two-product model**: Tokenelo stays a free, wallet-free, local evidence tool, and EloCoin is a separate opt-in service with its own terms that *consumes* verified usage. The docs already anticipate "separate terms" for future hosted services (README L25) and say EloCoin is "a separate product pursuit" (licensing L7).
- Reversing #1 (no issuance, redemption or return) inside the Tokenelo README would be a visible public walk-back days after publication. It would also tie the tracker's credibility (its core value prop for procurement and FinOps) to token speculation.
- Terminology hazard: "token" throughout the repo means LLM tokens (e.g., "token accounting", SECURITY L17). An "ELO token" would overload the word, so docs would need explicit disambiguation.

### Gaps
- No governance document, legal opinion, token terms or regulatory analysis exists in the repo to say which disclaimers were written with EloCoin specifically in mind (beyond licensing L7).

---

## 4. Data accuracy and trust: how usage data is collected, and the tamper/gaming risk if UCU becomes money

### Takeaway
All usage data is **client-side and self-hosted**. It is parsed from local records of tools like Claude Code and Codex, from user-"configured local inference", or from an optional local metering proxy pointed at an upstream "the operator configures". It is stored in a user-writable local SQLite ledger. **Nothing is API-verified against vendors.** Invoice reconciliation is only "proposed". The security model explicitly excludes the local admin, compromised accounts and malicious upstreams. As money, UCU from this pipeline would be trivially forgeable.

### Cited Findings
- Collection: the tracker "parses supported usage records" and stores "normalized counts and metadata in a local SQLite ledger". "Local proxy metering, if configured, handles request/response traffic to obtain counters." ([docs/privacy.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L7))
- "Local metering proxies can contact the upstream endpoint the operator configures." ([docs/privacy.md#L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L13))
- Sources include "configured local inference" ([README.md#L27](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L27)).
- "Provider records and identifiers are untrusted inputs." ([SECURITY.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L15))
- "Local administrator access, a compromised account and a malicious upstream remain outside the protection offered by token accounting." ([SECURITY.md#L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L17)) "This does not provide isolation from an administrator or a compromised account on the same computer." ([docs/privacy.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L15))
- Count-quality caveats: "Missing or legacy qualification metadata is unrecorded, not proof of a complete count." ([docs/data-accuracy.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L7)) "Parent sessions may already include subagent usage." ([L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L13)) "Zero means a known value of zero. Blank, unknown, unavailable, incomplete, estimated and unpriced carry different meanings. Failed reads must not silently become zero." ([L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L15))
- Vendor verification is manual: the "Accountability workflow" steps are human comparison of an export "with the vendor's reporting for the same scope" ([docs/data-accuracy.md#L31-L35](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L31-L35)). "Automated invoice reconciliation is a proposed feature" ([L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L37)). The roadmap item "Explore vendor invoice/rate-card comparison" is unchecked ([docs/roadmap.md#L18](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L18)).
- A dedicated "Data discrepancy" issue template exists for count, cost or coverage mismatches ([.github/ISSUE_TEMPLATE/data_discrepancy.yml](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/.github/ISSUE_TEMPLATE/data_discrepancy.yml#L1-L7)). This shows count disagreement with vendors is an expected, normal occurrence.
- No signed installer is claimed ([docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29)), so client integrity cannot be attested.

### Inferences (gaming and tamper vectors if UCU mints value)
- **Direct DB edit:** the local SQLite ledger is under user control. Rows can be inserted or inflated.
- **Fabricated source logs:** the adapters parse local tool records, so synthetic log files would be ingested. The repo itself encourages "fabricated records that preserve the shape" for bug reports ([CONTRIBUTING.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L7)), which shows the shapes are reproducible.
- **Rogue upstream or proxy:** the operator chooses the upstream endpoint, so a self-run server can return arbitrary usage counters.
- **Self-dealing local inference:** "configured local inference" lets users meter their own model. Usage is unbounded and unverifiable, and may run on tiny models while claiming large-model rates if model identity is self-declared.
- **Wash usage and arbitrage:** if UCU-to-ELO minting value exceeds the marginal cost of tokens (cheap models, cache reads, flat-rate plan quotas), users profit by burning compute. Flat-rate subscription plans ("Plan quotas", README L21) make marginal cost near zero.
- **Double counting:** subagent-in-parent and reasoning-in-output subsets are already flagged as risks (data-accuracy L9, L13). A minting rule that errs here creates free coins.
- **Sybil and fleet:** no account or identity exists, so multiple hosts or installs can each claim usage. Fleet peer sharing (privacy L13) adds cross-host aggregation risk.
- **Uncertainty:** visible calibration and uncertainty flags (README L37) mean a "UCU" is a range or a qualified estimate, not a settleable quantity.
- Net: today's design is an **honest evidence tool, not a trust-minimized meter**. Turning it into a mint requires moving the trust root off the user's machine (vendor-signed usage, server-side metering, or hardware attestation).

### Gaps
- The repo does not show whether any vendor adapter calls vendor usage APIs, or only reads local files. The internal adapter code is not public.
- No measured error rates between Tokenelo counts and vendor invoices are published.

---

## 5. Components missing for a token

### Takeaway
Essentially **every token-critical component is absent**. Present today (internally, per the docs) are only: a local usage parser and normalizer, a local SQLite ledger, a loopback bearer-auth read API, optional peer "fleet" sharing, CSV/JSON export, and a versioned price table. The public repo itself contains none of these, only docs.

### Cited Findings: component checklist

| Component needed for a compute token | Status in repo | Evidence |
|---|---|---|
| Verifiable measurement / oracle (vendor-signed or attested usage) | **Absent.** Inputs are "untrusted"; the user and admin are outside the threat model; reconciliation is only "proposed" | [SECURITY.md#L15-L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L15-L17); [docs/data-accuracy.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L37) |
| Open, versioned UCU methodology | **Absent.** "Methodology/source scope is still being reviewed"; UCU methods excluded from the public commit; roadmap item unchecked | [README.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L37); [commit 0bddb89](https://github.com/Schadenfroyd/Tokenelo/commit/0bddb89); [docs/roadmap.md#L24](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L24) |
| Calibration data and uncertainty figures | **Absent.** Required to be "visible", but no values published | [README.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L37) |
| User identity / accounts / KYC-AML | **Absent by design.** "no Tokenelo account"; "No … hosted account requirement is announced" | [README.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L25); [docs/privacy.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L25) |
| Wallet linkage | **Absent by design.** "no … crypto wallet" | [README.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L25) |
| Shared / public ledger or chain, mint and burn logic, smart contracts | **Absent.** The only "ledger" is a local SQLite DB | [docs/privacy.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L7) |
| Redemption mechanism (what 1 ELO buys) | **Absent and disclaimed** ("redemption") | [README.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L37) |
| Hosted / public API for submissions | **Absent.** Only a loopback local read API with bearer auth, plus optional peer fleet | [docs/privacy.md#L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L13); [docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29) |
| Published data schema / field dictionary | **Pending.** "will publish a field dictionary and example" | [docs/data-accuracy.md#L27](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L27); [docs/roadmap.md#L11](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L11) |
| Public source code and tests | **Absent.** "No public source or binary version has been released"; the only CI is a Markdown link check | [CHANGELOG.md#L9](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CHANGELOG.md#L9); [.github/workflows/docs.yml#L22](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/.github/workflows/docs.yml#L22) |
| License | **Pending.** Apache-2.0 "approved licensing plan", "not a license grant"; licensor entity not yet identified | [docs/licensing.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L5) |
| Signed / attested client | **Absent.** "No signed installer … is claimed" | [docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29) |
| External security audit, compliance certification, billing certification | **Absent.** "no external audit or compliance certification is claimed"; no "billing certification" | [SECURITY.md#L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L17); [docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29) |
| Incident response SLA / bug bounty | **Absent.** "no remediation SLA is promised" | [SECURITY.md#L11](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L11) |
| Data retention / deletion policy | **Absent.** "No automatic retention period or certified data-erasure guarantee is claimed now" | [docs/privacy.md#L21](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L21) |
| Governance (methodology change control, foundation, voting) | **Absent.** Only the repository owner's moderation discretion; DCO "proposed" | [CODE_OF_CONDUCT.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CODE_OF_CONDUCT.md#L7); [CONTRIBUTING.md#L13](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/CONTRIBUTING.md#L13) |
| Legal entity, terms of service, token disclosures | **Absent.** Only "Elo AI" named; "no paid service is announced"; trademark registration not asserted | [README.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L25), [#L47](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L47); [docs/trademarks.md#L5](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/trademarks.md#L5) |
| Pricing / valuation basis | **Partial.** "Versioned API-equivalent price comparisons" exist internally but are expressly not cash value | [README.md#L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L17); [docs/data-accuracy.md#L19](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L19) |
| Coverage / unknown-state handling (needed so a mint never treats unknown as a value) | **Present as principle.** Zero, blank, unknown, estimated and unpriced are distinct | [docs/data-accuracy.md#L15](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L15) |
| Provenance fields (rate provenance, model/source identity, qualifications) | **Present internally** (CSV v2) | [docs/data-accuracy.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/data-accuracy.md#L25) |

### Inferences
- The reusable assets for EloCoin are mostly **methodological discipline**: component-level token fields, subset de-duplication rules, explicit unknown and estimated states, rate provenance, and a versioned price table. These are good foundations for a published measurement spec, but none of them provide **verification**.
- The minimum pre-token sequence implied by the repo's own acceptance bar ([docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29), "until its evidence exists") would be:
  1. Ship the public alpha (all 7 items).
  2. Publish the versioned UCU spec with calibration and uncertainty.
  3. Ship vendor reconciliation.
  4. Add a verified data path (vendor-signed or server-side metering).
  5. Commission an external audit.
  6. Only then add separate token issuance infrastructure, with its own entity, terms, identity and wallet layer.

### Gaps
- No internal design docs for EloCoin (tokenomics, chain choice, issuance or redemption model) exist in this repo.
- Whether vendors (Anthropic, OpenAI and others) expose signed usage receipts or admin usage APIs usable as an oracle is outside this repo. It would require external research.

---

## 6. Existing mentions of crypto, blockchain, tokens-as-currency, or compliance

### Takeaway
Every crypto or financial mention in the repo is a **negative disclaimer**. "EloCoin" appears exactly once, to say it is separate from and not part of the tracker launch. There are **zero** mentions of blockchain, chain, smart contracts, mint, stake, stablecoin, KYC, AML, securities, regulation, jurisdiction or the ticker "ELO"/"Elos".

### Cited Findings
- "EloCoin is a separate product pursuit and is not part of the tracker launch." (the only EloCoin mention) ([docs/licensing.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/licensing.md#L7))
- "…no Tokenelo account, paid subscription, crypto wallet, or reward mechanism." (the only "crypto" mention) ([README.md#L25](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L25))
- "…does not establish output quality, a cash balance, token issuance, redemption, or a financial return." ([README.md#L37](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/README.md#L37))
- "No signed installer, supported hosted service, billing certification or financial return is claimed until its evidence exists." ([docs/roadmap.md#L29](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/roadmap.md#L29))
- Compliance: "Security review is ongoing; no external audit or compliance certification is claimed." ([SECURITY.md#L17](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/SECURITY.md#L17))
- "Ledger" is used only for the local SQLite store ([docs/privacy.md#L7](https://github.com/Schadenfroyd/Tokenelo/blob/30a5cea/docs/privacy.md#L7)).
- A case-insensitive grep over all tracked `.md`, `.yml` and `.mjs` files, plus all git history and both PR refs, found no hits for: blockchain, chain, smart contract, mint, stake, stablecoin, attest, oracle, KYC, AML, SEC, regulat*, legal, jurisdiction, "Elos". "Elo" appears only within "Tokenelo", "Elo AI" or "EloCoin". (Search run locally against commit `30a5cea` and `refs/pull/{1,2}/head`; see [commit history](https://github.com/Schadenfroyd/Tokenelo/commits/main).)
- Git history shows no removed crypto content. The only removed text is the initial README line "Tokenelo is used to track AI token-based activity toward UCU computation." ([commit 71200b6](https://github.com/Schadenfroyd/Tokenelo/commit/71200b6))

### Inferences
- The repo's authors anticipated readers conflating UCU with a crypto token and pre-emptively disclaimed it in four places (README L25, README L37, roadmap L29, licensing L7). This reads as deliberate legal and positioning hygiene to keep the free tracker clear of securities and consumer-finance questions, which supports a "separate entity / separate repo" EloCoin strategy.
- There is no existing compliance groundwork (KYC/AML, securities analysis, money-transmission, tax) to build on. All of it would be net-new.

### Gaps
- Regulatory classification of a UCU-backed token, ticker availability for "ELO", and any internal EloCoin planning documents cannot be determined from this repo. They need external or legal research and access to non-public materials.
