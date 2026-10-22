# Contributing

Tokenelo is preparing its public source release. You can improve the public documentation or send product feedback now. Product-source contributions can be reviewed once the release scope and license grant are cleared.

## Choose a way to help

- **Improve the documentation.** Documentation pull requests are welcome. Run `node --test scripts/check-docs.test.mjs` and `node scripts/check-docs.mjs` before submitting; these checks need no dependency installation.
- **Share feedback or report a problem.** Use the [issue forms](https://github.com/Schadenfroyd/Tokenelo/issues/new/choose) to suggest an improvement or describe a tracking issue.
- **Report a security concern privately.** Use [private vulnerability reporting](SECURITY.md), not a public issue.

## Make a report useful and safe

Explain the workflow, tool/version, operating system, selected range, expected result and observed result. Distinguish recorded counts from an invoice or estimate. Use fabricated records that preserve the shape of the problem. Never post raw usage logs, databases, credentials, customer names or personal project paths.

For Claude cloud work, follow the [public documentation runbook](docs/claude-cloud.md)
and run `node scripts/cloud-check.mjs`. The command adds checkout and runtime
verification to the documentation checks without installing dependencies.

Product-source contributions must wait for the cleared release scope and license. The [current status](docs/status.md) and [release and licensing details](docs/licensing.md) explain what remains pending.

## Proposed contribution policy for the source release

Contributions will use the adopted repository license. The proposed origin policy is a Developer Certificate of Origin sign-off on each contribution commit. Sign-off certifies the contributor's right to submit the work; it is not copyright assignment. The adopted policy and exact developer commands will accompany the source release.

Changes to accounting require examples covering missing data, known zero, caching/reasoning subsets, model/source identity and relevant ranges. Claims about privacy or billing need evidence. Keep UI language concise and navigation consistent with token tracking and reporting.

Avoid dependency, license, data-format or collection-policy changes without explaining the effect. Maintainers may request revision or decline work that changes the free local tracking commitment.

No response-time guarantee or support contract is offered through public issues.

[Maintainer workflow](docs/maintaining.md) · [Current status](docs/status.md)
