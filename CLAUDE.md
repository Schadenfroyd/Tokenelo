# Tokenelo public repository

This checkout contains the Apache 2.0 tracker source (`src/`, `test/`, `rates/`, `packaging/`, `native/`), public project documentation, artwork, repository tooling, a static marketing site in `site/`, and its separately deployed gateway source in `site-gateway/`.
Token tracking, reporting, data depth, and vendor accountability define its scope.

## Start here

- Read `README.md`, `CONTRIBUTING.md`, `docs/status.md`, and `docs/licensing.md`. For website changes, read `docs/website.md`.
- Use [the Claude cloud runbook](docs/claude-cloud.md) for environment setup and handoff.
- Run `node scripts/cloud-check.mjs` before editing and again before handing off.
- Node.js 22.13 or newer and Git are sufficient. No package installation, service,
  database, private network, or credentials file is needed for documentation work.
  Source work needs `npm ci`; see `docs/quick-start.md`.

## Work and publication boundaries

- Branch from current public `main`; use a separate branch for each task.
- Keep all changes within the publication scope in `scripts/check-docs.mjs`: exact
  files for documentation, site and tooling, and scoped paths for the source tree.
  Review scope additions as changes to the publication scope.
- Installers, signed builds, private engineering history, captured usage, customer
  data, and operational configuration remain outside this repository.
- The tracker source is released under Apache 2.0 (see `LICENSE`). Binary and
  installer publication require clearance of the exact release scope.
- Preserve current history and repository protection. Do not force push, delete
  branches, publish releases, bypass checks, or merge your own pull request.
- Use fabricated examples. Keep unknown counts, measured zero, incomplete coverage,
  and Standard API-equivalent comparisons distinct. Do not claim invoice accuracy,
  complete capture, supported platforms, or shipping readiness without evidence.
- Reuse the existing tone and navigation. Keep claims dated and qualified.

## Verification and handoff

The verification command checks runtime and the clean public history root,
documentation tests, inventory, local links, anchors, and content
guardrails. It does not prove product acceptance or legal clearance.

If a hosted origin uses an opaque proxy URL, its transport format remains
unverified; identity comes from the known public ancestry and checked inventory.
The verifier can complete a shallow clone by fetching only explicit public `main`.

Return the base and resulting commit, changed files, commands and actual results,
unresolved limitations, and one concrete next task. Use a pull request for reviewed
documentation changes. Keep a cloud session private unless explicitly approved for
sharing, and do not contact third parties without explicit authorization.
