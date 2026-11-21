## Part A

- [x] Bundle SQL with a deterministic generator and drift test; document regeneration.
- [x] Apply migrations once per isolate/database before API and cron work, retrying failures.
- [x] Share Wrangler migration history and tolerate concurrent migration completion.
- [x] Test fresh, existing, partial and failing databases and health isolation.
- [x] Remove the registry database ID and verify dry-run build and local migrations.
- [x] Fail closed without an operator allowlist; retain explicit local bypass.
- [x] Update security documentation and validate typecheck, tests, lint, build and specs.

## Part B

- [x] Add ordered one-command deployment with `pnpm run deploy`.
- [x] Configure npm trusted publishing with supported Node/npm and OIDC permissions.
- [x] Raise the Better Auth peer minimum to 1.7.16 and align the compatibility matrix.
- [x] Update README deployment, publishing and update procedures.
