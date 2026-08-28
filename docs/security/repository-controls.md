<!-- doc: role=security control record; stage=stable -->

# Repository security controls

This record translates the accepted v1 decisions in issue #11 into verifiable repository and
GitHub-hosted controls. It does not contain secrets, private collection data, or a second policy.

## Controls in the repository

- [`SECURITY.md`](../../SECURITY.md) routes confidential reports to GitHub Repository Security
  Advisories and states the pre-release support boundary.
- [`.github/dependabot.yml`](../../.github/dependabot.yml) checks the root npm lockfile and GitHub
  Actions references weekly. Dependabot pull requests use the normal CI gates and maintainer
  review; there is no auto-approval, auto-merge, grouping, ignore rule, or gate bypass.
- `AGENTS.md`, `.gitignore`, the artifact checker, and synthetic fixtures keep real
  `*.snoredex-private.json` exports outside routine repository/agent workspaces and reject the
  suffix or private-value canaries from tracked/build outputs.
- The static entry pages carry the first-applicable default-deny meta CSP. The browser smoke gate
  verifies its directives and the absence of inline executable scripts.

## GitHub-hosted controls to activate and verify

These controls are settings owned by repository administrators, not custom workflows. Activate
them in the same issue-backed release-gate change and record the resulting setting evidence in
issue #11 before release acceptance:

1. Enable GitHub Private Vulnerability Reporting for this public repository and ensure the sole
   maintainer receives security-alert notifications. Do not add a security mailbox, upload form,
   third-party disclosure service, or public disclosure automation.
2. Enable GitHub CodeQL **default setup** for JavaScript/TypeScript. Use the GitHub-managed query
   suite; do not add a custom CodeQL workflow, query pack, CLI job, or duplicate scanner. Wait for
   the first scan, triage its findings, and only then register its actual stable check name as a
   required rule.
3. Activate one `main` ruleset after the real CI check names are stable. Require pull requests,
   the actual designated CI gates, and blocked force-push/deletion; keep zero approvals for the
   single-maintainer v1 workflow. Never pre-register a phantom check or bypass Dependabot.
4. Keep squash-only merging and automatic feature-branch deletion enabled; merging remains
   distinct from publication/deployment.

The exact activation timestamp, setting URL/screenshot, CodeQL scan result and required-check
names belong in the issue/release evidence. Until that evidence exists, the release gate remains
open and this document must not be read as a claim that the GitHub-hosted settings are active.
