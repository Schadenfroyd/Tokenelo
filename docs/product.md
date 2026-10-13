# Product overview

## Who it is for

Tokenelo is being built for engineering teams investigating AI usage, procurement teams reviewing vendor reports, and FinOps teams explaining rate-card comparisons. Its value is the depth of local evidence it can deliver for free.

## The core product contract

| Capability | Intended behavior | Qualification |
| --- | --- | --- |
| Token tracking | Normalize supported usage records by source, model, session, and recorded components. | Formats, counters, and source coverage vary; a running collector is not proof of completeness. |
| Drill-downs | Keep the records behind a total inspectable within the selected range. | Parent/subagent inclusion and missing fields need explicit treatment. |
| Rate comparisons | Explain Standard API-equivalent values using versioned prices and assumptions. | Served-tier pricing, invoices, discounts, and subscription quotas are separate evidence. |
| Reporting | Export useful local CSV and JSON data. | Raw identifiers and metadata can be sensitive; exports are not automatically anonymous. |
| Diagnostics | Expose capture and interpretation limitations. | Unknown and failed reads must not be presented as verified zero. |

These are acceptance requirements for the cleared release. See the [current status](status.md) for what is verified and what remains open.

## Local use and optional sharing

The tracker is intended to work without an account, payment, wallet, or central upload. Supported local source records are normalized into a local ledger. A deliberately configured proxy can process traffic to obtain usage counters. Optional fleet sharing needs separate configuration, authentication, and a documented aggregate-data boundary.

[Privacy and network boundaries](privacy.md)

## A useful vendor conversation

Start with the same tools, models, time window, and coverage on both sides. Inspect recorded components and their qualifications. Compare a reviewed export against vendor reporting, then state the assumptions and unresolved differences. Tokenelo is intended to help make that conversation precise; automatic invoice reconciliation is a proposed feature.

## Architecture at a glance

The internal implementation uses source adapters, a local SQLite ledger, an authenticated local read API, and a desktop interface. Supported release builds, exact collection behavior, schemas, and developer instructions will be documented with cleared source. This overview is not a public API compatibility promise.

[Data accuracy](data-accuracy.md) · [Roadmap](roadmap.md) · [FAQ](faq.md)
