<!-- doc: role=security and privacy policy; stage=stable -->
# Security and privacy

Supported-release and deployment status lives in the owning issues and release records. These
security and privacy boundaries apply to every prototype, fixture, and release.

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
- Render untrusted strings through text APIs and apply a self-first Content Security Policy.
- Limit import size, quantities, note length, and accepted enums/IDs; never prototype-merge
  untrusted objects.
- Preserve readable state and offer backup before reset, replace, import, or migration.
- Use synthetic data in tests, issues, screenshots, and bug reports.

Security fixes that affect both repositories follow the issue protocol privately until coordinated
disclosure is safe.
