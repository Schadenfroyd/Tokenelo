# Project status

**Snapshot: October 12, 2026 · internal alpha · public release in preparation.**

Tokenelo's primary purpose is free token tracking, reporting, and useful local evidence for vendor accountability. This page reports engineering progress; it is not a supported-release announcement.

## Available in this repository

- Product overview, data interpretation, privacy, security, and licensing plan.
- Roadmap, contributor guidance, and structured issue forms.
- Repository artwork and automated documentation checks.

Product source, private operational history, captured records, databases, and installers are excluded. Source and binary publication remain pending counsel clearance of the exact release scope.

## Internal engineering snapshot

| Area | Verified observation | Limit |
| --- | --- | --- |
| Candidate checks | The latest checked candidate completed the 3,017-case test population on each of Windows, macOS, and Linux, together with type and bundle checks. | Windows and macOS: 3,001 passed / 16 skipped each; Linux: 3,003 passed / 14 skipped. No test failures in those runs. Existing platform skips remain disclosed. |
| Build comparison | The candidate's compiled backend files matched across those three runs. | This does not establish reproducible signed installers or public platform support. |
| Lifecycle reliability | Scoped checks exercised accepted-work draining, startup cleanup, explicit CLI refusal, and proxy admission during shutdown. | Finite owned fixtures do not establish general latency bounds, fresh vendor capture, or every shutdown path. |
| Installed applications | A fresh read-only observation confirmed saved process identities and installed package hashes on all three internal platforms. | Those installations use older builds; the checked candidate is **not installed**. Process presence does not prove current capture or correct UI data. |

The original internal alpha criteria remain unaccepted. Full release readiness has not been established. Internal checks are recorded privately; sensitive evidence and farm details are not published here.

## Work needed before a public release

1. Complete lifecycle and storage recovery checks, then qualify controlled candidate rollout.
2. Establish independent vendor-count and baseline accuracy, pricing provenance, and count-quality evidence.
3. Finish authenticated fleet, proxy, API, and security acceptance.
4. Review all nine screens, ranges, selectors, controls, modals, and data drill-downs across supported platforms and themes, including physical interaction.
5. Verify three-platform install, upgrade, uninstall, rollback, reboot, and export behavior.
6. Complete mutation testing, required independent reviews, release inventory, dependency notices, and signing/notarization preparation.
7. Obtain counsel clearance for the exact public source, patent grant, and binary distribution; then publish the cleared Apache 2.0 release.

## Findings and opportunities

**Verified finding:** an owned internal parser fixture currently normalizes absent native counters and explicit zero counters to the same numeric result. This is a parser observation, not evidence about a vendor's live reporting behavior.

**Proposed improvement:** make count-quality receipts distinguish an unavailable counter from measured zero, with explicit evidence for known components. The proposal is not implemented or accepted. It requires full-pipeline qualification and preservation of historical price and accounting behavior.

**Proposed improvement:** a local shutdown/recovery receipt could make incomplete draining or recovery visible to an operator. This is also unimplemented and requires retention and cleanup review.

[Roadmap](roadmap.md) · [Data interpretation](data-accuracy.md) · [License plan](licensing.md)
