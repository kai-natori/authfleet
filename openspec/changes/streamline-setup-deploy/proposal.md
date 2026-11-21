# Streamline setup and deployment

## Why

First deployment currently requires manual registry provisioning and migrations,
and an omitted operator allowlist silently weakens the security boundary.

## What Changes

- Bundle registry migrations and apply them before API traffic and scheduled work,
  sharing Wrangler's migration history and failing closed on errors.
- Let Wrangler provision the named D1 binding without a committed database ID.
- Require a non-empty operator allowlist outside explicit local development.
- Provide `pnpm run deploy` for ordered API and web deployment.
- Publish the plugin through npm trusted publishing from GitHub Actions.
- Raise the Better Auth peer floor to `>=1.7.16 <2`.
- Update README setup, deployment, publishing and upgrade procedures alongside changes.

## Impact

Affected capability: authfleet. API startup gains registry writes only; target
databases remain read-only. Existing CLI migration history remains compatible.
Deployment orchestration, publishing and the supported peer floor are included.
