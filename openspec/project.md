# AuthFleet — project context

AuthFleet is a self-hosted, multi-project dashboard for Better Auth apps,
Cloudflare-first. An operator registers several of their own Better Auth
projects and switches between them in one dashboard to see user counts and
growth.

Tagline: "One dashboard for all your Better Auth apps — self-hosted on
Cloudflare."

## Stack

- pnpm monorepo
- `apps/api` — Hono on Cloudflare Workers. **No public exposure**: it is
  reachable only through a Cloudflare service binding from `apps/web`.
- `apps/web` — TanStack Start + shadcn/ui (Base UI, neutral). Sits behind
  Cloudflare Access.
- `packages/core` — framework-free shared logic (registry, remote D1
  reading, crypto, snapshots, stats).
- `packages/plugin` — the `authfleet` npm package: a read-only Better
  Auth plugin installed in target apps (change `add-agent-plugin`).
- DB: Cloudflare D1 + Drizzle. Row IDs are lowercase ULIDs.
- `apps/mcp` — deferred (not in v1); the layout leaves room for it.

## Connection models (two, since `add-agent-plugin`)

Projects have a `type`, and both types satisfy the same
`ProjectStatsReader` contract in `packages/core`, so statistics,
snapshots and the dashboard behave identically for both:

- `d1` (pull): api reads the project's D1 through the Cloudflare D1
  HTTP query API with a per-project read-only Cloudflare token.
- `agent` (in-app plugin): the `authfleet` plugin inside the target
  app serves counts over HTTPS from the app's own Better Auth DB
  adapter — any database, schema customisation included. The registry
  stores the app's Better Auth base URL plus the plugin API key
  (encrypted with the same AES-GCM + AAD scheme as D1 tokens).
  Registration verifies the plugin (`GET /authfleet/validate`) before
  saving.

### Plugin invariants (counts-only, read-only)

- The plugin exposes exactly two GET endpoints
  (`/authfleet/validate`, `/authfleet/stats`) and returns aggregate
  counts only — no user rows, emails, ids or session data, ever.
- The plugin never writes to the host app's database, holds only a
  SHA-256 hash of the project API key (timing-safe comparison), logs
  no key material, and has no dev-mode bypass.
- Plugin absence / unreachability / contract-version mismatch are
  first-class dashboard states, never rendered as zero users.

### Versioning policy (three independent versions)

- **Endpoint contract version** (the `version` field, currently 1):
  additive within a version; a breaking change increments it and the
  dashboard keeps reading the previous one for at least one release.
- **Plugin package version**: semver of the `authfleet` npm package.
- **Better Auth peer range**: `>=1.7.16 <2`, fixture-tested on 1.7.16 and
  1.7.25 (`packages/test-ba-floor` is the minimum-version matrix cell).

## Specification status and validation

Run `pnpm spec:validate` to validate all active changes and current specifications
strictly, then check task completion in archived changes. The five implementation
changes for 0.2.0 are archived under `openspec/changes/archive/`; there are no
active changes at release closure. The current specifications are:

- [Dashboard](specs/authfleet/spec.md)
- [Agent plugin](specs/agent-plugin/spec.md)
- [Release readiness](specs/release-readiness/spec.md)

The two operator runtime checks from `add-authfleet-v1` and `add-agent-plugin`
were explicitly deferred outside the implementation changes because deployment
was excluded. They remain unchecked in
[the operator verification checklist](../docs/operator-verification.md).
Archive records retain that scope decision; no runtime task was marked as
executed. Do not claim deployment verification without completing that checklist.

The archive was applied in dependency order: `add-authfleet-v1`,
`add-agent-plugin`, `streamline-setup-deploy`, `harden-security-audit-2`,
then `finish-release-readiness`. The base specification now exists, so the
previous archive-order INFO is resolved.

Read the original proposals in order with the later changes. The original
plugin's `>=1.4 <2` range is historical: `streamline-setup-deploy` supersedes it
with `>=1.7.16 <2`. Likewise, `finish-release-readiness` removes the remote CLI
migration shortcut in favor of the runtime runner's data-preservation safeguard.
The research spike's old version numbers describe the original investigation,
not the current supported versions.

## Security invariants

- Stored project credentials (Cloudflare API tokens for `d1` projects,
  plugin API keys for `agent` projects) are encrypted at rest
  with AES-GCM (WebCrypto); the key comes from a Worker secret
  (`TOKEN_ENCRYPTION_KEY`). Credentials are never stored in plaintext and never
  logged.
- Project API tokens are read-only (D1 read) by instruction and by design:
  core only ever issues `SELECT` queries against target databases.
- The api Worker has `workers_dev = false` and no routes. The only caller
  is the web Worker via a service binding. Every api call must carry the
  operator identity (the Cloudflare Access authenticated email forwarded
  by web); calls without it are rejected. A dev bypass exists for local
  development only and must never be enabled in production.
