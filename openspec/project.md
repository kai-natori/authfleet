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
- `apps/web` — TanStack Start + shadcn/ui (Radix base, neutral). Sits behind
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
