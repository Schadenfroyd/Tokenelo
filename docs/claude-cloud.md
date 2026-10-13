# Work on Tokenelo in Claude cloud

The public repository is ready for documentation and repository-tooling tasks.
Application engineering belongs in the separately authorized engineering workspace;
this checkout contains no tracker source or installers. Keep that distinction in
task prompts, pull requests, and handoffs.

## Repository and environment

| Setting | Use |
| --- | --- |
| Repository | `Schadenfroyd/Tokenelo` |
| Starting branch | Current public `main` |
| Environment name | `Tokenelo public documentation` |
| Runtime | Node.js 22 or newer and Git |
| Network | None for repository checks; Trusted only when the task needs external documentation |
| Environment variables and secrets | None required |
| Setup command | `bash .claude/cloud-setup.sh` from the cloned repository root |
| Verification | `node scripts/cloud-check.mjs` |

Connect GitHub through Claude's supported connection flow and attach only this
public repository to the documentation session. Prefer a fresh remote clone over
uploading a local checkout with additional history. The GitHub connection handles
repository authentication; do not copy a token into the repository or setup script.
[Claude's GitHub connection and remote-clone guidance](https://code.claude.com/docs/en/claude-code-on-the-web)

Claude's hosted environment currently provides Node.js 22. The committed setup
script selects it when needed and performs checks without downloading anything.
Configure the setup command in the cloud environment: committing the script alone
does not register it there. Environment setup can be cached, so the task must also
run the verification command on its actual checkout. Network, setup, and runtime
defaults can change; recheck the provider guidance when provisioning.
[Claude's cloud environment documentation](https://code.claude.com/docs/en/cloud-environments)

## First task prompt

Use this as a bounded starting task:

```text
Work only in Schadenfroyd/Tokenelo, starting from current public main.
Read CLAUDE.md, the contribution guide, status, and licensing documents.
Run node scripts/cloud-check.mjs and inspect the current public documentation.
Choose one concrete improvement to navigation, clarity, accessibility, or
fabricated reporting examples. Keep product source and restricted material out.
Implement the improvement on a new branch, run the verification command again,
and return a reviewable pull request with exact changes, results, and limitations.
Do not merge, publish a release, or change repository settings or history.
```

The root `CLAUDE.md` supplies repository instructions. Confirm it is present in
the session's loaded context before doing work. These instructions guide the
agent; repository checks, branch protection, and maintainer review provide separate
controls. [Claude's project-instruction documentation](https://code.claude.com/docs/en/memory)

## Checks and return path

- `node scripts/cloud-check.mjs` is the complete local gate for this repository.
  It runs `node --test scripts/check-docs.test.mjs scripts/cloud-check.test.mjs`
  and `node scripts/check-docs.mjs` after checking the clean public ancestry.
  A shallow checkout fetches only explicit public `main` without tags or other refs.
  An opaque provider proxy origin remains unverified as a transport; the known
  public root and inventory establish the checked content's repository lineage.
- `.claude/commands/verify-public.md` provides the same verification workflow for
  Claude sessions that load repository commands. The direct command remains the
  fallback when custom commands are unavailable.
- The required GitHub `links` check runs the same verification command. Leave
  protections intact and resolve review conversations before a maintainer merges.
- Use Claude's built-in GitHub tools or REST API operations for a pull request
  when the hosted GitHub proxy does not support a CLI operation. Do not create an
  alternate token or weaken repository protection to work around a tool error.
- Return the starting commit, result commit, changed paths, actual check output,
  evidence limits, unresolved decisions, and the next bounded task.

Passing these checks establishes documentation consistency for the checked commit.
It does not establish authenticated cloud access, tracker build acceptance, platform
support, counsel clearance, or a public release. A cloud environment is operational
only after an actual session clones the intended branch, completes setup, and
returns its checked result.

[Maintainer workflow](maintaining.md) · [Current status](status.md) · [Release scope](licensing.md)
