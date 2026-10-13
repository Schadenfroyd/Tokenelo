# Maintaining the public repository

This repository has a separate public history. Private engineering history, captured records, databases, farm configuration, and restricted release material must remain outside it.

## Change workflow

1. Branch from current `main`; keep the change limited to the public scope.
2. Check claims against actual evidence. Label proposals and qualification limits.
3. Run `node scripts/cloud-check.mjs` for checkout identity, clean public ancestry,
   documentation tests, and the inventory/link/content checks.
4. Open a pull request. Documentation CI and conversation resolution must pass.
5. Review the final changed files for release scope, privacy, origin, and licensing.
6. Squash merge after the required checks; retain the PR's evidence and review scope.

The repository owner is the current maintainer. `CODEOWNERS` routes review requests; it does not establish independent engineering or legal review. The current single-maintainer policy requires passing checks and resolved conversations, without a mandatory second approval. Revisit that policy when additional maintainers join.

## Automated checks

The public-scope checker verifies local links and anchors, required documentation, the current documentation/tooling inventory, and unsafe SVG content. It rejects common private operational paths and key markers in public prose and assets. It is a guardrail, not a comprehensive secret scanner or proof of counsel clearance.

GitHub secret scanning, push protection, private vulnerability reporting, and read-only workflow defaults provide additional controls. Actions must be pinned to full commit SHAs. Dependency updates are limited to the repository's GitHub Actions configuration.

## Release transition

Product source or binaries require counsel clearance of the exact release scope. At that point, update the public inventory guard deliberately, add the reviewed license and third-party notices, publish a tested support matrix and installation path, and replace preparation copy with the actual release's status.

Do not label an internal candidate a public release or treat finite test runs as complete acceptance. Update the [status snapshot](status.md) with an actual observation date rather than silently changing historical claims.

The [Claude cloud runbook](claude-cloud.md) documents a dependency-free public
environment and a bounded task prompt. Repository instructions and setup scripts
do not prove an authenticated cloud session has been provisioned; record the actual
session's checked commit and results when it runs.
