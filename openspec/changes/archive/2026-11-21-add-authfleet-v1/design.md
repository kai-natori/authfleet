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

Defence in depth on top of the binding (hardened per the 2026-11-15
security audit, findings F1/F2/F8):

- Web also sets `workers_dev: false`: it is reachable only on the
  custom domain the Access application covers, so every path to the
  web Worker traverses Access.
- Web's server-side client forwards the operator identity on every
  binding call as `x-authfleet-operator: <email>`. The email comes from
  the **verified** Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`):
  web checks the RS256 signature against the team JWKS, the audience
  (AUD) and expiry before trusting any claim (`apps/web/src/server/
  access.ts`). The plain `Cf-Access-Authenticated-User-Email` header is
  never trusted — it is spoofable on any path that reaches the Worker
  without traversing Access. Configuration is
  `AUTHFLEET_ACCESS_TEAM_DOMAIN` + `AUTHFLEET_ACCESS_AUD` on web; when
  either is set, both are required and a missing/invalid JWT fails
  closed. When neither is set (local dev only), no header identity is
  accepted at all.
- Api middleware requires the operator header on every route except
  `/health` (which returns no data). Missing → `401`; non-email-shaped
  → `401`; when `AUTHFLEET_OPERATOR_EMAILS` is configured, an operator
  outside the allowlist → `403` (this converts the Access policy from a
  single point of failure into one layer of two). Api never trusts
  identity headers from anywhere else because there is no other route
  in, and it does not echo the operator identity in responses — web
  displays the identity from its own verified JWT.
- **Dev bypass**: when `AUTHFLEET_DEV_BYPASS=1` (local `.dev.vars` only),
  api falls back to `AUTHFLEET_DEV_OPERATOR` (default `dev@local`), and
  web's client sends the same fallback when no Access configuration
  exists. The bypass is inert whenever Access verification is
  configured. This flag must never be set in production; README and
  `.dev.vars.example` say so, and neither Worker's committed wrangler
  config carries the flag at all (absence = off).

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
  record, IV stored beside the ciphertext. The ciphertext is bound to
  its row via AAD — `authfleet:project-token:v1:<projectId>` — so a
  transplanted ciphertext does not decrypt under another project
  (audit F5); decryption rejects IVs that are not 12 bytes. The project
  id is therefore generated before encryption at creation time.

## Decision: error surface

Api endpoints that read a target project (stats, snapshot) return a
generic error (`failed to read project stats`) when the upstream
Cloudflare call fails; the detailed cause (Cloudflare error codes and
messages, kept in `D1ReadError.detail`) is written to server-side logs
only (audit F3). Target-project config values are format-validated at
creation (account id: 32 hex chars; database id: UUID) and
URL-encoded when the Cloudflare API URL is built (audit F4). Core's
reader enforces single-statement SELECT-only queries internally
(audit F6), so read-only behaviour does not rest on caller discipline.

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
