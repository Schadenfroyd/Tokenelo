# Third-party inventory — findings and open questions

This directory holds a generated inventory of the development dependency tree and notes on what it does and does not cover. It is not legal advice and is not a notice for a distributed build. No installer or signed build is published; see the root [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## What is in this directory

| File | Purpose |
| --- | --- |
| `inventory.json` | One record per `package-lock.json` entry: version, integrity, SPDX license, license class, dev/optional/peer flags, platform, license-file hashes. The source of truth for the other files. |
| `INVENTORY.md` | Generated tables: license classes, licenses, non-permissive packages, duplicates, every package. |
| `sbom.cdx.json` | CycloneDX 1.5 SBOM of the same tree, with dependency edges and sha512 hashes. |
| `THIRD-PARTY-NOTICES.md` | **Candidate** notice text collected from installed packages. Not a release notice (see F2/F5). |
| `../../scripts/third-party-inventory.mjs` | Zero-dependency generator. `--write [--online]` regenerates; `--check` verifies offline. |

All four data files are generated; edit the script or the lockfile, never the outputs.

## Findings

**F1 — The locked tree is development tooling only.** All 370 lockfile entries are `dev: true`, and
`package.json` declares no runtime `dependencies`. The seven direct devDependencies are `@types/node`,
`electron`, `electron-builder`, `esbuild`, `tsx`, `typescript`, `vitest`.

**F2 — The compiled product embeds no third-party package code.** The only bare-module import in
`src/` is `electron`, in two files (`src/tray/main.ts`, `src/tray/preload.ts`). The compiled `dist/`
imports only Node built-ins (`node:*`) and `electron`. The renderer is bundled by `scripts/build-tray.mjs` from local
modules, with no package imports to pull in. (`dist/collectors/claude-desktop.js` mentions
`node_modules` only inside a comment.) So the source and compiled files you would publish do not
contain other people's package code.

**F3 — Licenses: 92 permissive, 12 weak copyleft, 0 strong copyleft, 0 unresolved.**
MIT 83, Apache-2.0 4, ISC 3, BSD-2-Clause 1, BSD-3-Clause 1, MPL-2.0 12. The 12 MPL-2.0 entries are
`lightningcss` and its 11 platform binaries, pulled in by `vite` through `vitest`. MPL-2.0 is
file-level copyleft and only matters if those files are redistributed or modified; they are test
tooling. License data: 56 packages read from installed copies; 48 platform-specific binary packages
(which cannot install on Linux) from the npm registry metadata field. **The license texts of those 48
were not read from their tarballs**; they belong to the same families (`@esbuild/*`, `@rolldown/binding-*`,
`lightningcss-*`, `fsevents`) as installed siblings.

**F4 — Apache-2.0 packages with extra notice files.** `typescript@5.9.3` ships `LICENSE.txt` (9.2 KB)
and `ThirdPartyNoticeText.txt` (37.8 KB); both are in the candidate notices. Only relevant if TypeScript itself
were redistributed.

**F5 — What a release will actually redistribute is not covered by this inventory.** The runtime
pieces are not in the lockfile as shipped code:
- The **Electron binary** (the `electron` package downloads it in a lifecycle script, which cloud
  setup disables). Electron is MIT, but its distribution bundles Chromium and other components whose
  notices travel in the Electron distribution files.
- **Node.js**: `package.json` requires >= 22.13 and the ledger and collectors use `node:sqlite`. If an
  installer bundles Node rather than requiring it, Node's license notices become a distribution matter.

I found no installer or packaging tool chosen in the files I read, so I cannot say which of these a
release bundles. Inventory the actual artifact at release-candidate time.

**F6 — Native helper.** `src/daemon/native/report-job-host.cs` is first-party C#, compiled with
Microsoft's `csc.exe` (.NET Framework 4); the 14 KB `native/report-job-host.exe` is checked in with a
manifest recording source hash, binary hash and compiler hash. I found no copyright, SPDX or
"adapted from" style markers in the source.

**F7 — Data and content with outside origins.**
- `rates/prices.json` cites vendor pricing pages and fetch dates. Prices are facts, but vendor terms of
  use for any redistribution are a separate question.

**F8 — Project license.** `LICENSE` and `NOTICE` are at the root and `package.json` sets `license` to
Apache-2.0. Regenerate this directory when the lockfile changes.

**F9 — Lockfile hygiene is good.** All 370 entries resolve from `registry.npmjs.org` and carry sha512
integrity (re-verified 2026-10-28 from `package-lock.json`). Nineteen package names appear at more than
one version (for example `undici` 6.29.1 / 7.30.1, `minimatch`, `fs-extra`, `semver`, `@types/node`); most
are nested under `electron-builder`.

## Suggested next steps (not done here)

1. Decide the packaging approach, then inventory the shipped artifact (Electron distribution license
   files, Node if bundled) and regenerate notices from that, not from the dev tree.
2. Add `node scripts/third-party-inventory.mjs --check` to the CI workflow so a lockfile change cannot
   drift from the inventory. It currently exits 1 because of the WTFPL package noted below.

## Reproduce

```text
bash scripts/claude-cloud-setup.sh                          # pinned Node 22.23.4, locked dev packages
node scripts/third-party-inventory.mjs --write --online     # needs node_modules + registry access
node scripts/third-party-inventory.mjs --check              # offline; exits 1 on drift or a bad license
```

`--check` fails on: a lockfile change since generation, a missing/extra/changed package, an unresolved
license, a strong-copyleft or unknown license, a non-registry source, missing sha512 integrity, and any
generated file that no longer matches the inventory. Weak-copyleft packages produce a warning.

## What was validated

- `--write --online`: 104 packages, 0 unresolved licenses (2026-10-13 lockfile).
- Regenerated 2026-10-28 against lockfile sha256 `c6eb8ca0…`: 370 packages, 0 unresolved licenses; `--check` exits 1 because `truncate-utf8-bytes@1.0.2` (WTFPL, via `sanitize-filename` ← `electron-builder`) is classed unknown. Dev tooling only; counsel/engineering must decide whether the packaging toolchain ships it before any release. Twelve MPL-2.0 entries are all `lightningcss` platform builds.
- `--check` passes, and fails for each of five deliberate corruptions (edited SBOM, edited notices,
  changed lockfile bytes, blanked license, introduced GPL-3.0-only).
- `sbom.cdx.json` validates against the CycloneDX 1.5 JSON schema (schema files from the
  `@cyclonedx/cyclonedx-library` snapshot, checked with Ajv), a corrupted copy is rejected, bom-refs are
  unique, and there are no dangling dependency references.
- Network use by the generator: 48 GET requests of public npm package metadata. No usage data, model
  or vendor API calls.
