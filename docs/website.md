# Public Tokenelo website

The public marketing website is a buildless static site in the site directory. It uses HTML, CSS, vanilla JavaScript, and SVG. The site source has no hosted data service, account flow, analytics code, cookie handling, or visitor-data upload.

The website explains the project from public repository documentation. It links to the tracker source in this repository but does not include internal builds, private operational material, or product acceptance evidence. The report illustration is conceptual and uses fabricated values; keep that label visible anywhere the example appears.

## Content boundaries

- Describe Tokenelo as free AI usage tracking and reporting for vendor accountability.
- Keep availability clear: internal alpha, no public installer or supported release, source available under Apache 2.0, and Windows, macOS, and Linux under internal verification.
- Describe Apache 2.0 as the license of the source in this repository, as stated in `LICENSE`. Do not describe installers, signed builds, or hosted services as available.
- Keep unknown, incomplete, unpriced, and measured zero distinct. Standard API-equivalent comparisons are not invoices.
- Use only public documentation for privacy and product statements. Session metadata and exports can be sensitive; do not imply an external audit or complete capture.
- Use fabricated examples. Keep private application data, captured screenshots, farm details, and restricted release material out of the site.

The [product overview](product.md), [data-accuracy guide](data-accuracy.md), [privacy model](privacy.md), [release status](status.md), and [licensing status](licensing.md) are the content sources.

## Source and interaction

Keep the site dependency-free. Do not add remote scripts, fonts, images, APIs, analytics, or network-backed interactions. Keep site assets local and make all primary content readable if JavaScript is unavailable. The report tabs may switch among the browser-local fabricated examples; they must never fetch or submit data.

Use semantic HTML, keyboard-operable controls, visible focus, readable contrast, and reduced-motion support. Preserve the T mark from the public Tokenelo artwork or derive it as original SVG. Do not add third-party brand assets.

The repository checker verifies the website inventory, local HTML assets and anchors, allowed outbound links, private markers, and runtime-resource boundaries. Run the repository's public verification command described in the [maintainer workflow](maintaining.md).

## Publishing and response handling

The GitHub Pages workflow automatically verifies and publishes the site directory from main. It also supports a manual workflow dispatch. The GitHub Pages CNAME remains deliberately unset, and the site artifact contains no CNAME file. The default project Pages URL is the upstream for the exact-host Cloudflare Worker that serves tokenelo.eloai.co. The public Worker, tests, and non-secret route configuration live under site-gateway/ and deploy independently; the gateway is not part of the Pages artifact. Do not put credentials, private DNS values, or access tokens in this repository or GitHub Actions. Tracker source and release binaries remain unavailable pending counsel clearance.

Successful static responses from the gateway include Cache-Control: public, max-age=60, s-maxage=60, no-transform. The 60-second browser and shared-cache lifetimes remain unchanged. The no-transform directive prevents Cloudflare's automatic Web Analytics and JavaScript Detections script injection into the HTML response, so the existing Content Security Policy stays intact. See Cloudflare's [Web Analytics setup for proxied sites](https://developers.cloudflare.com/web-analytics/get-started/) and [JavaScript Detections guidance](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/).

Cloudflare and GitHub Pages still process ordinary HTTP requests to serve, cache, route, and secure the site; hosting security features may use request metadata or security cookies. The Tokenelo page code adds no analytics JavaScript, account flow, cookie handling, or visitor-data upload.

Website publication does not mean an installer is available. Check the [current status](status.md) before describing installation, compatibility, or licensing.
