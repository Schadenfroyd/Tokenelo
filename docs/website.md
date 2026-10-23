# Public Tokenelo website

The public marketing website is a buildless static site in the site directory. It uses HTML, CSS, vanilla JavaScript, and SVG. It has no package install, hosted data service, account system, analytics, cookie layer, or upload flow.

The website explains the project from public repository documentation. It does not expose tracker source, internal builds, private operational material, or product acceptance evidence. The report illustration is conceptual and uses fabricated values; keep that label visible anywhere the example appears.

## Content boundaries

- Describe Tokenelo as free AI usage tracking and reporting for vendor accountability.
- Keep availability clear: internal alpha, no public installer or supported source build, and Windows, macOS, and Linux under internal verification.
- Describe Apache 2.0 as the planned license only. Source publication and the exact license grant remain pending counsel clearance.
- Keep unknown, incomplete, unpriced, and measured zero distinct. Standard API-equivalent comparisons are not invoices.
- Use only public documentation for privacy and product statements. Session metadata and exports can be sensitive; do not imply an external audit or complete capture.
- Use fabricated examples. Keep private application data, captured screenshots, farm details, and restricted release material out of the site.

The [product overview](product.md), [data-accuracy guide](data-accuracy.md), [privacy model](privacy.md), [release status](status.md), and [licensing status](licensing.md) are the content sources.

## Source and interaction

Keep the site dependency-free. Do not add remote scripts, fonts, images, APIs, analytics, or network-backed interactions. Keep site assets local and make all primary content readable if JavaScript is unavailable. The report tabs may switch among the browser-local fabricated examples; they must never fetch or submit data.

Use semantic HTML, keyboard-operable controls, visible focus, readable contrast, and reduced-motion support. Preserve the T mark from the public Tokenelo artwork or derive it as original SVG. Do not add third-party brand assets.

The repository checker verifies the website inventory, local HTML assets and anchors, allowed outbound links, private markers, and runtime-resource boundaries. Run the repository's public verification command described in the [maintainer workflow](maintaining.md).

## Publishing plan

The GitHub Pages workflow automatically verifies and publishes the site directory from main. It also supports a manual workflow dispatch. The GitHub Pages CNAME remains deliberately unset, and the site artifact contains no CNAME file. The default project Pages URL is the upstream for the exact-host Cloudflare Worker that serves tokenelo.eloai.co. The public Worker, tests, and non-secret route configuration live under site-gateway/ and deploy independently; the gateway is not part of the Pages artifact. Do not put credentials, private DNS values, or access tokens in this repository or GitHub Actions. Tracker source and release binaries remain unavailable pending counsel clearance.

Website publication does not mean the tracker is available. Check the [current status](status.md) before describing installation, compatibility, or licensing.
