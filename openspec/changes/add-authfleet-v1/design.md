# Design — AuthFleet v1

## Layout

```
apps/
  api/      Hono Worker. Registry CRUD, stats, snapshots cron.
            NO public exposure (see "Binding security model").
  web/      TanStack Start + shadcn/ui dashboard. Behind Cloudflare Access.
  mcp/      (deferred — not created in v1)
packages/
  core/     Framework-free logic: ids, crypto, remote D1 reader,
            registry repository contract, stats math, snapshot job,
            demo fixtures.
openspec/   Specs and changes.
```

## Decision: connection model for reading a target project

**Chosen: each registered project carries its own read-only Cloudflare
API token; core queries that project's D1 over the Cloudflare D1 HTTP
query API** (`POST /accounts/{account_id}/d1/database/{database_id}/query`).

Each registry row is `{ name, cfAccountId, d1DatabaseId, tokenCiphertext,
tokenIv, tokenHint }`. At read time api decrypts the token in memory and
hands it to core's `RemoteD1Reader`; the token is used for one request
batch and never returned, logged or cached in plaintext.

Alternatives considered and rejected:

- _Service binding / direct D1 binding per project_: a Worker can only
  bind D1 databases in the same Cloudflare account, binds are static
  config (a new project would need a redeploy), and it cannot serve other
  operators' accounts. The HTTP API + per-project token is dynamic and
  matches the "register a project at runtime" requirement.
- _Require a plugin/agent inside each target app_: extra install burden
  on every project; the data needed (row counts on the `user` table) is
  already reachable through the platform API.
- _Scrape the official dashboard_: against its terms and brittle.

Consequences: target tokens must be **read-only D1 tokens**; core only
ever issues `SELECT`s, so even a leaked decrypted token cannot mutate a
target database beyond what the token's scope allows. The registry D1
becomes the crown-jewels store, which is why tokens are AES-GCM
encrypted at rest and api is not publicly reachable.

### Target `user` table reading rules

- Table name: `user`, falling back to `users` (detected via
  `sqlite_master`).
- Columns probed via `pragma_table_info`: anonymous split uses the first
  present of `is_anonymous`, `isAnonymous`, `is_anon`; absence yields
  `anonymousUsers: null` (UI hides the split).
- `created_at` probing: Better Auth on D1 stores timestamps either as
  epoch milliseconds (integer), epoch seconds (integer, detected by
  magnitude), or ISO text. The reader probes one row's value type and
  picks the matching SQL for per-day grouping; unknown shapes degrade to
  total-only stats.

## Decision: api↔web via service binding only (binding security model)

**The api Worker is not a public API.** In `apps/api/wrangler.jsonc`:

- `"workers_dev": false` — no `*.workers.dev` URL.
- No `routes` — no custom domain is attached.

The only network path to api is the **service binding** declared in
`apps/web/wrangler.jsonc` (`services: [{ binding: "API", service:
"authfleet-api" }]`). Service-binding calls never traverse the public
internet and cannot be made by anyone who does not control a Worker in
the same account bound to api.

Defence in depth on top of the binding:

- Web's server-side client forwards the operator identity on every
  binding call as `x-authfleet-operator: <email>`, taken from the
  `Cf-Access-Authenticated-User-Email` header that Cloudflare Access
  injects in front of web (so it cannot be spoofed by a browser — Access
  strips/replaces it at the edge).
- Api middleware requires that header on every route except `/health`
  (which returns no data). Missing operator → `401`. Api never trusts
  identity headers from anywhere else because there is no other route in.
- **Dev bypass**: when `AUTHFLEET_DEV_BYPASS=1` (local `.dev.vars` only),
  api accepts `x-authfleet-operator` as-is / falls back to
  `AUTHFLEET_DEV_OPERATOR` (default `dev@local`), and web's client sends
  the same fallback when no Access header exists. This flag must never
  be set in production; README and `.dev.vars.example` say so.

Local dev exception: in local development, web calls api over HTTP
(`AUTHFLEET_API_URL`, default `http://127.0.0.1:8788`) because both run
under `wrangler dev` / vite on one machine; the operator header rule and
dev bypass apply identically. Production config uses the binding.

## Decision: dashboard auth via Cloudflare Access (no self-built auth)

v1 is a single-operator (or small trusted team) tool. Building accounts,
passwords and sessions into AuthFleet would add the highest-risk code to
the app that guards every other project's credentials. Cloudflare Access
in front of web provides identity, allowlisting and sessions at zero
code. AuthFleet stores no operator passwords and issues no cookies of its
own.

## Decision: IDs and secrets

- Row IDs: **lowercase ULIDs** (time-ordered, D1/SQLite-friendly) via
  `packages/core` `newId()`.
- Secrets are never ULIDs: stored project tokens are operator-supplied;
  any token AuthFleet itself generates uses `crypto.getRandomValues`
  (≥32 bytes). Encryption: AES-GCM with a 256-bit key from the
  `TOKEN_ENCRYPTION_KEY` Worker secret (base64), random 96-bit IV per
  record, IV stored beside the ciphertext.

## Decision: snapshots in api's scheduled handler

Growth history must survive even if a target DB's `created_at` data is
unusable, so api's cron trigger (daily) writes one `snapshots` row per
project per day with the live total. The dashboard combines snapshots
(long-range growth) with live per-day signup counts (recent detail).
Snapshot writes are idempotent per (project, day) via a unique index +
upsert.

## Demo mode

`AUTHFLEET_DEMO=1` makes api prepend a fixture project ("Demo — Acme")
whose stats come from deterministic generated data in core. It exercises
registry, switching and charts with zero real credentials. Demo projects
are read-only in the UI and skipped by the snapshot job.

## MCP (deferred)

`apps/mcp` is intentionally not built in v1. When it lands, it will be a
thin adapter over `packages/core` (or over api), read-only first
(`list_projects`, `get_user_count`, `get_user_growth`).
