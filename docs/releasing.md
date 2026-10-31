# Release operations — internal candidate

1. Confirm the approved licensor, license text, exact source manifest and the excluded-methods boundary. Close the source sensitivity and third-party data rights findings. A root LICENSE alone does not establish authority to publish every file.
2. Keep the private repository as the working system of record. Export an explicit reviewed source snapshot into public history; do not mirror the private repository or its research/operational history.
3. Remediate and re-audit development/runtime dependencies. Lock versions, retain required notices and inventory the actual Node/Electron/Chromium artifacts delivered on each platform.
4. Test the exact public source edition from a clean install. Run both TypeScript projects, meaningful accounting/security contracts, default tests and the advertised platform smoke tests. A previous private pass is supporting evidence, not a public CI result.
5. Review every advertised screen and drill-down for scope, identity, freshness, count/price/calibration quality, keyboard accessibility and coherent copy. Label synthetic examples. Do not expose recorded user telemetry in screenshots.
6. Verify migrations, graceful shutdown and a package rollback that preserves post-upgrade data. Never restore an old backup over later captured records.
7. Open a protected public PR. Require passing applicable checks; review exported history for sensitive material. Preserve exact source/release identities and a concise known-limits record.
8. Publish an alpha tag/release only with actually produced artifacts. Binary distribution needs appropriate notices, build provenance, platform smoke tests and signing/notarization decisions. Do not advertise signatures, provenance attestations or installers that do not exist.
9. Record release support scope, security ownership and maintenance capacity. Maintain the free local tracker commitment; hosted support/services require their own terms and staffing.

No automatic publisher or npm-registry release is enabled by these drafts.
