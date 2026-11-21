# Changelog

## 0.2.0 — 2026-11-21

### Plugin

- **Breaking:** require Better Auth `>=1.7.16 <2` instead of `>=1.4 <2`.
  Upgrade the host's Better Auth version before upgrading AuthFleet.
- Keep endpoint contract v1 and the read-only, counts-only response format.
- Refactor daily signup bucketing and add coverage for bounded reads and dates.

### Self-hosted dashboard

- Apply registry migrations automatically before API operations and snapshots.
  Preserve snapshot history during the legacy project-table rebuild.
- Deploy with `pnpm run deploy`, retaining existing secrets and provisioning D1.
- Bound plugin responses and request duration; verify identity before key
  generation and apply server-function CSRF protection.
- Require repository checks before npm publishing or Cloudflare deployment.
  Add opt-in deployment from main; use npm trusted publishing.

See `SECURITY-AUDIT.md` for verification scope and installation-specific checks.

## 0.1.0 — 2026-11-16

- Initial public Better Auth plugin release, endpoint contract v1.
