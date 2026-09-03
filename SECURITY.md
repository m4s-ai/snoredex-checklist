<!-- doc: role=security and privacy policy; stage=stable -->

# Security and privacy

Supported-release and deployment status lives in the owning issues and release records. These
security and privacy boundaries apply to every prototype, fixture, and release.

The supported version is the currently deployed v1 application revision named by the live
[`deployment.json`](https://m4s-ai.github.io/snoredex-checklist/deployment.json) and
[`provenance.json`](https://m4s-ai.github.io/snoredex-checklist/provenance.json). A retained rollback
generation is a bounded recovery target, not a separately maintained release while it is inactive.
No unsupported response-time promise is made.

## Report a vulnerability

Use GitHub Private Vulnerability Reporting or a private Security Advisory for confidential details.
If that channel is unavailable, contact the repository owner privately. Do not open a public issue
containing exploit details, credentials, personal collection data, or storage exports.

A sanitized cross-repository tracking issue may record impact and coordination without secrets.
Catalogue corrections that are not security-sensitive belong in the producer issue tracker.

## Required safeguards

- Private collection state stays in one versioned browser-local envelope and never leaves the
  browser without an explicit user export.
- No analytics, telemetry, remote fonts, third-party scripts, or private values in URLs/logs.
- Validate catalogue, migration, and import data at trust boundaries; unsupported versions and
  integrity failures fail closed.
- Bind every published HTML shell to one immutable runtime-module manifest. Build, deployment, and
  artifact checks reject missing, mixed, additional, or changed active and rollback module bytes
  before publication. Post-deploy smoke detects live discrepancies and fails the workflow but does
  not automatically restore the previous publication. The shell's CSP-bound import-map integrity
  table and entry/theme SRI values block changed runtime bytes before browser execution. Each route
  separately validates the catalogue input it consumes before rendering; the collection route also
  validates migration identity before reconciliation or private-state access.
- Render untrusted strings through text APIs and apply a self-first Content Security Policy.
- Limit import size, quantities, note length, and accepted enums/IDs; never prototype-merge
  untrusted objects.
- Preserve readable state and offer backup before reset, replace, import, or migration.
- Use synthetic data in tests, issues, screenshots, and bug reports.
- Real `*.snoredex-private.json` exports must remain outside this repository and routine agent
  workspaces. Never attach, paste, upload, index, or ask an agent to inspect one in a public
  channel; an authorized narrow exception still treats every byte as untrusted data.

Security fixes that affect both repositories follow the issue protocol privately until coordinated
disclosure is safe.

The dated repository-setting evidence and required release gates are recorded in
[`docs/security/repository-controls.md`](docs/security/repository-controls.md).
