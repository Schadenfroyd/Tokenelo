# Tokenelo

**Free AI token tracking and reporting, built for vendor accountability.**

Tokenelo helps engineering, procurement, and FinOps teams understand recorded AI usage: which tools and models were used, how token counts were reported, and what evidence supports a total.

Track locally. Inspect the breakdown. Take a clear report into your next vendor conversation.

> **Release status:** internal alpha; public source release is being prepared. This repository currently hosts the project overview and release plan. An open-source license and downloadable release have not yet been issued. The free tracker is the primary product; UCU is a secondary measurement feature.

## What the tracker is being built to deliver

| Need | Tokenelo approach | What to check |
| --- | --- | --- |
| Understand usage | Recorded token components by source, model and session | Supported source formats and missing coverage |
| Explain a total | Drill into the normalized records behind it | Range, capture time, count quality and subagent inclusion |
| Evaluate cost | Versioned API-equivalent price comparisons | List-price assumptions, unpriced models and discounts |
| Take evidence with you | Local JSON and CSV reporting | Identifiers, export schema and sharing permissions |
| Spot blind spots | Coverage and diagnostic views | A running app does not prove captured usage |

**Recorded usage is evidence, not an invoice.** Plan quotas, negotiated rates, discounts, rounding, and activity outside the captured sources can differ from a vendor bill. Unknown or missing data must stay visible.

## Designed for useful, free adoption

The planned local tracker requires no Tokenelo account, paid subscription, crypto wallet, or reward mechanism. It is intended to remain useful on its own. Optional future hosted services would have separate terms; no paid service is announced here.

Tokenelo's internal implementation includes adapters for Claude Code, Codex, and configured local inference, plus selected tool metadata. Availability depends on source records and configuration. Public platform/build instructions and the exact supported-source matrix will accompany the cleared source release.

## Privacy and trust

The tracker is designed to store usage metadata and counts rather than prompt/response bodies. Metadata still deserves protection: session identifiers, host names, timestamps and project paths can reveal activity. Raw exports are not anonymous. Share only reviewed, sanitized examples in issues.

Fleet sharing is optional. Future central analytics would require an explicit policy and user choice. [Read the privacy model](docs/privacy.md) and [report a security concern](SECURITY.md).

## UCU, in context

UCU is a secondary, versioned compute-measurement feature under review. Its uncertainty and calibration status must be visible. It does not establish output quality, a cash balance, token issuance, redemption, or a financial return. Public methodology/source scope is still being reviewed.

## Follow the release

- [Roadmap and acceptance criteria](docs/roadmap.md)
- [How to interpret usage data](docs/data-accuracy.md)
- [Release and license status](docs/licensing.md)
- [Contributing](CONTRIBUTING.md) and [community conduct](CODE_OF_CONDUCT.md)
- [Project questions](https://github.com/Schadenfroyd/Tokenelo/issues)

Built by Elo AI. Vendor and product names identify supported sources; they do not imply endorsement.
