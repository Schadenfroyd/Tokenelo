# Tokenelo public repository

This checkout contains public project documentation, artwork, and repository tooling.
Token tracking, reporting, data depth, and vendor accountability define its scope.

## Start here

- Read `README.md`, `CONTRIBUTING.md`, `docs/status.md`, and `docs/licensing.md`.
- Use [the Claude cloud runbook](docs/claude-cloud.md) for environment setup and handoff.
- Run `node scripts/cloud-check.mjs` before editing and again before handing off.
- Node.js 22 or newer and Git are sufficient. No package installation, service,
  database, private network, or credentials file is needed.

## Work and publication boundaries

- Branch from current public `main`; use a separate branch for each task.
- Keep all changes within the explicit inventory in `scripts/check-docs.mjs`.
  Review inventory additions as changes to the publication scope.
- Product source, installers, private engineering history, captured usage, customer
  data, and operational configuration remain outside this repository.
- Source and binary publication require counsel clearance of the exact release
  scope. The approved Apache 2.0 plan is not an issued license grant.
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
