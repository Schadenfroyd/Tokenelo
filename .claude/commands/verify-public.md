# Verify the public documentation checkout

Run `node scripts/cloud-check.mjs` from the repository root. Inspect its exit code
and actual output; do not replace a failing check with an unverified claim.

Report the checked commit, branch, changed files, checks run, and any failures.
Keep the verification scope limited to public documentation and repository tooling.
Do not install dependencies, access captured data, change repository protection,
publish a release, or merge a pull request as part of this command.
