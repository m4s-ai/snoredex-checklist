<!-- doc: role=contribution workflow; stage=stable -->
# Contributing

Start with [`AGENTS.md`](AGENTS.md), the owning issue, every comment, and every linked authority.
For catalogue or migration work, also read the paired producer issue and the relevant upstream
README, HANDOVER, and LESSONS documents.

## Issue-driven workflow

1. Work from one owning issue and identify whether producer or consumer owns the change.
2. Make the specification ready using [`SPECIFICATIONS.md`](SPECIFICATIONS.md).
3. Create one feature branch per issue; do not push directly to `main`.
4. Implement the smallest change that satisfies the recorded acceptance scenarios.
5. Run the smallest regression check during development and the full repository gates before the
   pull request.
6. Inspect the diff and any catalogue/state-conservation report before requesting review.
7. Record cross-repository lifecycle changes in both issues before merge or deployment.

The repository has no application commands yet. Add commands to `README.md` and workflows together
with the implementation that makes them true; do not document speculative tooling.

## Pull-request contract

A pull request must state:

- its local owning issue and full cross-repository counterpart URL;
- the affected authority and invariant;
- contract version, fingerprint, and compatibility when catalogue semantics are involved;
- migration, private-state, and rollback behavior;
- the acceptance checks run and their result;
- whether the change closes the local issue or only advances a master specification.

Use closing keywords only for the local implementation issue. A consumer PR must not close a
producer issue, and a merge is not a publication or verification event.

## Data and privacy

- Never commit, log, attach, or paste real collection-state exports, notes, quantities, tokens,
  cookies, or storage dumps. Use synthetic fixtures.
- Never infer missing catalogue identities, localities, finishes, translations, or migrations.
- Render producer-controlled text as text, not trusted HTML.
- Destructive import, replace, reset, and migration flows require validation, preview, backup, and
  explicit confirmation.

## Documentation

Keep stable rules in `AGENTS.md`, stable design boundaries in repository documents, changing plans
and decisions in issues, and commands in `README.md`/workflows. Use LF, UTF-8 without BOM, and keep
`CLAUDE.md` as a pointer rather than a second rules file.
