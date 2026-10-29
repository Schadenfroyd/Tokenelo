# Third-party notices

This file summarizes third-party license status for the source tree; it is a checklist, not a completed license notice for a distributed build. No installer or signed build is published. Generated candidate notices for the development dependency tree are in [docs/third-party/THIRD-PARTY-NOTICES.md](docs/third-party/THIRD-PARTY-NOTICES.md).

The current resolved dependency tree has 370 entries, all development-only (regenerated 2026-10-28 from the 2026-10-25 lockfile; see docs/third-party/INVENTORY.md). Declared licenses: 283 MIT, 36 ISC, 12 MPL-2.0 (all `lightningcss` platform builds), 10 BSD-3-Clause, 9 Apache-2.0, 8 BlueOak-1.0.0, 6 BSD-2-Clause, and single entries of 0BSD, Python-2.0, WTFPL, WTFPL OR ISC, (MIT OR CC0-1.0) and (WTFPL OR MIT). One package (`truncate-utf8-bytes`, WTFPL) is classed unknown by the inventory checker. The older 104-entry and 159-entry inventories are historical. Preserve each dependency's actual required text/notice; metadata is not a substitute for those texts.

The twelve MPL-2.0 entries are development-tool components introduced in the refreshed toolchain. Apache licensing of Tokenelo's original source does not replace their MPL license or remove obligations when covered source/binaries are redistributed. Record whether an actual release ships those components and preserve the applicable source/notice obligations. No CLA or custom Apache exclusion resolves third-party obligations.

An Electron/Node binary contains additional runtime components and notices. Inventory the exact delivered platform artifacts, including bundled Chromium and other third-party components. Do not assume a JavaScript lockfile is the complete runtime inventory. Keep original copyright/attribution notices and any required source/offer obligations applicable to the chosen artifact.

Review test-fixture origins, rate data, benchmark data, screenshots, fonts/icons and documentation assets separately. Do not redistribute a third-party dataset merely because the test code has a permissive license.

Before any installer or signed build is published, replace this checklist with notices for the exact delivered artifact, with explicit file-level exceptions where needed. License selection and dependency vulnerability acceptance are separate checks.
