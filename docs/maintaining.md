# Maintaining the public repository

This repository has a separate public history. It includes public documentation, repository tooling, and the static marketing website source in `site/` and separately deployed gateway source in `site-gateway/`. Private engineering history, captured records, databases, farm configuration, and restricted release material must remain outside it.

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

The public-scope checker verifies Markdown and website links, local anchors and assets, required files, the explicit publication inventory (exact files for documentation, site and tooling; scoped paths for application source), private operational markers, unsafe SVGs, and website runtime-resource limits. Website copy and assets are checked for private paths, restricted internal markers, unsafe links, remote scripts, fonts, and images. The Node test suite exercises the gateway allowlist and response behavior. These checks are guardrails, not a comprehensive secret scanner or proof of counsel clearance.

GitHub secret scanning, push protection, private vulnerability reporting, and read-only workflow defaults provide additional controls. Actions must be pinned to full commit SHAs. Dependency updates are currently limited to the repository's GitHub Actions configuration; npm dependencies of the source tree are not yet covered by automated updates.


## Public website source and publishing

The buildless marketing site lives in `site/` as HTML, CSS, vanilla JavaScript, and SVG. Keep it dependency-free and based only on public project documentation. The interactive report uses fabricated values and must remain clearly labeled. The website source under `site/` is a public documentation and marketing surface; it does not include tracker implementation or release binaries.

The main-branch GitHub Pages workflow verifies the public source and site, then uploads only the site directory. A manual workflow dispatch is also available. The GitHub Pages CNAME remains deliberately unset, and the site artifact contains no CNAME file. The default project Pages URL is the upstream for the exact-host Cloudflare Worker that serves tokenelo.eloai.co. The public Worker, tests, and non-secret route configuration live under site-gateway/ and deploy independently from the Pages workflow; the gateway is not part of the Pages artifact. Keep Cloudflare credentials, access tokens, and private DNS values out of this repository and GitHub Actions. Release binaries remain unavailable pending clearance of their exact release scope. See the [website source guide](website.md) for editing and publishing rules.

## Release transition

Source was released under Apache 2.0 on October 28, 2026; the inventory guard, license, notices and draft installation and support-matrix pages were added then. Binaries and installers need their own clearance of the exact release scope. At that point, publish signed, tested artifacts with a tested support matrix and installation path, and replace any remaining preparation copy with the actual release's status.

Do not label an internal candidate a public release or treat finite test runs as complete acceptance. Update the [status snapshot](status.md) with an actual observation date rather than silently changing historical claims.

The [Claude cloud runbook](claude-cloud.md) documents a dependency-free public
environment and a bounded task prompt. Repository instructions and setup scripts
do not prove an authenticated cloud session has been provisioned; record the actual
session's checked commit and results when it runs.
