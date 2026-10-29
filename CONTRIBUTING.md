# Contributing

Tokenelo's application source is published under Apache 2.0. You can improve the source or the documentation, or send product feedback.

## Choose a way to help

- **Improve the documentation.** Documentation pull requests are welcome. Run `node --test scripts/check-docs.test.mjs` and `node scripts/check-docs.mjs` before submitting; these checks need no dependency installation.
- **Improve the source.** Source pull requests are welcome. Use Node.js 22.13 or newer (`.nvmrc` pins the tested version; see the [quick start](docs/quick-start.md)), then run `npm ci`, `npm run typecheck`, `npm run build` and `npm test` before submitting. Tests import the compiled output, so build first.
- **Share feedback or report a problem.** Use the [issue forms](https://github.com/Schadenfroyd/Tokenelo/issues/new/choose) to suggest an improvement or describe a tracking issue.
- **Report a security concern privately.** Use [private vulnerability reporting](SECURITY.md), not a public issue.

## Make a report useful and safe

Explain the workflow, tool/version, operating system, selected range, expected result and observed result. Distinguish recorded counts from an invoice or estimate. Use fabricated records that preserve the shape of the problem. Never post raw usage logs, databases, credentials, customer names or personal project paths.

For Claude cloud work, follow the [public documentation runbook](docs/claude-cloud.md)
and run `node scripts/cloud-check.mjs`. The command adds checkout and runtime
verification to the documentation checks without installing dependencies.

Source contributions are licensed under Apache 2.0, as section 5 of the [license](LICENSE) provides. The [current status](docs/status.md) and [release and licensing details](docs/licensing.md) explain what remains pending for installers and supported releases.

## Contribution policy

Contributions use the repository license, Apache 2.0. The proposed origin policy is a Developer Certificate of Origin sign-off on each contribution commit (`git commit -s`). Sign-off certifies the contributor's right to submit the work; it is not copyright assignment. No tooling enforces it yet.

Changes to accounting require examples covering missing data, known zero, caching/reasoning subsets, model/source identity and relevant ranges. Claims about privacy or billing need evidence. Keep UI language concise and navigation consistent with token tracking and reporting.

Avoid dependency, license, data-format or collection-policy changes without explaining the effect. Maintainers may request revision or decline work that changes the free local tracking commitment.

No response-time guarantee or support contract is offered through public issues.

[Maintainer workflow](docs/maintaining.md) · [Current status](docs/status.md)
