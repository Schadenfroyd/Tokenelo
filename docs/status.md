# Project status

**Availability reviewed October 28, 2026 · internal alpha · source available under Apache 2.0 · no public app download yet.**

Tokenelo's primary purpose is free token tracking, reporting, and useful local evidence for vendor accountability. This page reports engineering progress; it is not a supported-release announcement.

## Available in this repository

- Tracker application source under Apache 2.0, with tests and build scripts. `native/` includes one prebuilt Windows helper executable with a provenance manifest; the build checks its exact bytes and copies it without running it.
- Product overview, data interpretation, privacy, security, and licensing status.
- Public static marketing site source and its illustrative, fabricated report example.
- Exact-host static-site gateway source and regression tests, separate from the tracker.
- Roadmap, contributor guidance, and structured issue forms.
- Repository artwork and automated documentation checks.

The tracker source is published here under [Apache 2.0](../LICENSE) as of October 28, 2026. Private operational history, captured records, databases, and installers are excluded. Installer and binary distribution remain pending clearance of their exact release scope.

## Internal UI fixture review — October 25, 2026

A private, uninstalled source candidate completed a fixture-only review of Today in Sessions and Local in both color themes. The review checked separate query-time labels, an unavailable recorded-time cutoff, a local-model session join, and the session detail against fabricated `FILED-EXAMPLE` records. It captured 20 hidden/offscreen UI states with no network requests.

This verifies only a bounded UI candidate against fabricated records. It does not establish live vendor capture, a current installation, measured usage totals, invoice reconciliation, public platform support, or release acceptance. The original internal alpha gates remained open at that review.

## Current qualification work

Work continues on installation and recovery, count quality and data provenance, and interface and drill-down verification across the three target platforms. The release gates below remain open. This is ongoing internal work, not a new release or platform-support announcement.

## Historical engineering snapshot — October 12, 2026

These observations describe the October 12 candidate and are retained with their original scope. They do not describe the latest candidate or establish current installed behavior.

| Area | Verified observation | Limit |
| --- | --- | --- |
| Candidate checks | The October 12 candidate completed the 3,017-case test population on each of Windows, macOS, and Linux, together with type and bundle checks. | Windows and macOS: 3,001 passed / 16 skipped each; Linux: 3,003 passed / 14 skipped. No test failures in those runs. Existing platform skips remain disclosed. |
| Build comparison | The candidate's compiled backend files matched across those three runs. | This does not establish reproducible signed installers or public platform support. |
| Lifecycle reliability | Scoped checks exercised accepted-work draining, startup cleanup, explicit CLI refusal, and proxy admission during shutdown. | Finite owned fixtures do not establish general latency bounds, fresh vendor capture, or every shutdown path. |
| Installed applications | A fresh read-only observation confirmed saved process identities and installed package hashes on all three internal platforms. | Those installations use older builds; the checked candidate is **not installed**. Process presence does not prove current capture or correct UI data. |

The original internal alpha criteria remain unaccepted. Full release readiness has not been established. Internal checks are recorded privately; sensitive evidence and farm details are not published here.

## Work needed before a supported release

The source was released under Apache 2.0 on October 28, 2026. The items below concern a supported release with installers.

1. Complete lifecycle and storage recovery checks, then qualify controlled candidate rollout.
2. Establish independent vendor-count and baseline accuracy, pricing provenance, and count-quality evidence.
3. Finish authenticated fleet, proxy, API, and security acceptance.
4. Review all nine screens, ranges, selectors, controls, modals, and data drill-downs across supported platforms and themes, including physical interaction.
5. Verify three-platform install, upgrade, uninstall, rollback, reboot, and export behavior.
6. Complete mutation testing, required independent reviews, release inventory, dependency notices, and signing/notarization preparation.
7. Obtain clearance for binary and installer distribution, then publish a tested, supported release.

## Findings and opportunities from the October 12 snapshot

**Verified finding:** an owned internal parser fixture was observed to normalize absent native counters and explicit zero counters to the same numeric result. This is a parser observation, not evidence about a vendor's live reporting behavior.

**Proposed improvement:** make count-quality receipts distinguish an unavailable counter from measured zero, with explicit evidence for known components. The proposal was not implemented or accepted in that snapshot. Qualification requires full-pipeline qualification and preservation of historical price and accounting behavior.

**Proposed improvement:** a local shutdown/recovery receipt could make incomplete draining or recovery visible to an operator. This was also unimplemented in that snapshot; retention and cleanup qualification are required.

[Roadmap](roadmap.md) · [Data interpretation](data-accuracy.md) · [License plan](licensing.md)
