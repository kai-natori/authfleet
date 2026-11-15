# Add agent plugin: DB-agnostic project connection

## Why

v1's pull model reaches a target project only through the Cloudflare D1
HTTP query API, so AuthFleet can only display Better Auth apps whose
database is Cloudflare D1. Most Better Auth apps run on other databases
(Postgres and friends), and for them v1 cannot show even a user count.

The official answer to that gap is Better Auth Infrastructure: an
in-app plugin (`dash()`) plus a hosted, paid dashboard. Competing with
it is acceptable — AuthFleet's positioning is the **free, self-hosted**
option (decided 2026-11-15). An AuthFleet plugin that lives inside the
target app reads through the app's own Better Auth DB adapter, which
makes it database-agnostic by construction, the same property that
makes the official plugin DB-agnostic.

## What changes

- **New plugin package** `packages/plugin`, published to npm as
  `authfleet`: a Better Auth **server** plugin factory
  `authfleet(options)` that a target app adds to its `betterAuth()`
  plugins. It registers **read-only GET endpoints** under the app's
  Better Auth base path, in the `/authfleet` namespace:
  - `GET /authfleet/validate` — connectivity and contract-version
    check; returns only `{ ok, version }`, no data.
  - `GET /authfleet/stats` — the same statistics contract the D1
    reader produces today (`totalUsers`, `dailySignups`,
    `anonymousUsers`, `asOf`) plus a contract `version` field.
    **Counts only — no user rows, no emails, no PII, ever.**
- **Endpoint security**: every plugin endpoint requires a per-project
  API key as `Authorization: Bearer`. The plugin is configured with
  only a **SHA-256 hash** of the key (plugin options or env) and
  compares hashes with a timing-safe comparison. The key is never
  logged, and there is no dev-mode bypass in the plugin. The dashboard
  side only ever calls plugin endpoints over HTTPS.
- **Data access inside the app** goes through Better Auth's own DB
  adapter obtained from the plugin endpoint context — no direct DB
  credentials, no SQL dialect assumptions. A research spike (see
  tasks group 1) must first verify this access pattern against Better
  Auth 1.4–1.7, the same support floor as `@better-auth/infra`.
- **Second project type in the registry**: projects gain a `type`.
  Existing projects are `d1` (Cloudflare account id + D1 database id +
  Cloudflare token). New `agent` projects store a **base URL** (the
  target app's Better Auth base URL) plus the plugin API key, encrypted
  with the same AES-GCM + per-project AAD scheme as D1 tokens.
- **`HttpAgentReader` in `packages/core`** implements the same reader
  contract as `RemoteD1Reader` (formalized as a `ProjectStatsReader`
  interface), so api stats routes, the snapshot cron and the dashboard
  work unchanged for both project types.
- **Dashboard**: the add-project form supports both types; project
  lists and the switcher show a type badge; `agent` projects whose
  plugin is unreachable or speaks an unsupported contract version show
  a clear status state instead of broken stats.
- **Docs**: README gains plugin install/registration instructions and
  the roadmap records the plugin as the decided v2 adapter.
- **Security audit round 2** after implementation (required, see
  tasks group 8): the plugin runs inside users' auth servers, the
  highest-sensitivity surface in this project.

## Out of scope (this change)

- Write operations of any kind (ban/delete users, session revoke).
  Read-only is a deliberate positioning and security decision — see
  design.md ("Decision: read-only plugin").
- Audit-log / event ingestion from target apps.
- Activity tracking or any schema mutation in target apps (no
  `lastActiveAt`-style fields).
- A client-side plugin (`authfleetClient()`); endpoints are called by
  the AuthFleet api Worker only, never by a browser.
- `apps/mcp` — still deferred.
- Combined cross-project totals/graphs (still not required, as in v1).
