# Add AuthFleet v1: multi-project Better Auth dashboard

## Why

Better Auth's official Infrastructure dashboard is a hosted SaaS and is
not open source; the OSS alternative (Better Auth Studio) is embedded per
app, so an operator running several Better Auth apps has no self-hosted
place to switch between their projects and check "how many users, and how
fast are we growing" for each. AuthFleet fills exactly that gap,
Cloudflare-first (Workers + D1), because the operator's existing projects
already run on Cloudflare D1.

## What changes

- New pnpm monorepo `authfleet` with `apps/api` (Hono Worker),
  `apps/web` (TanStack Start + shadcn/ui) and `packages/core`
  (framework-free logic).
- **Project registry** in a registry D1 (Drizzle schema + migration):
  `projects` (name, Cloudflare account id, D1 database id, encrypted API
  token, token hint) and `snapshots` (project id, date, total users).
- **Encrypted credentials**: project Cloudflare API tokens are encrypted
  with AES-GCM (WebCrypto) before storage; the key is a Worker secret
  (`TOKEN_ENCRYPTION_KEY`). Tokens are never returned by the API, never
  logged, and only a last-4 hint is kept for display.
- **Remote D1 reading model**: core reads each target project's D1 through
  the Cloudflare D1 HTTP query API using that project's read-only token,
  and counts rows in the Better Auth `user` table: total users, signups
  per day (from `created_at`), and the anonymous/guest split when an
  `is_anonymous`-style column exists (absence handled gracefully).
- **Daily snapshots**: the api Worker's scheduled (cron) handler records
  each project's total user count into `snapshots` once a day, giving
  growth history independent of the target DB.
- **Project switching UX**: web shows one selected project at a time via a
  project switcher: total users, new users (7d / 30d), daily signups and
  snapshot growth. There is explicitly **no requirement for combined
  totals or a combined cross-project graph** — switching is the feature.
- **Operator auth via Cloudflare Access**: web is deployed behind
  Cloudflare Access; the operator identity is the
  `Cf-Access-Authenticated-User-Email` header, trusted because Access
  terminates in front of web.
- **Api is not public**: the api Worker sets `workers_dev = false` and
  declares no routes. Web calls it exclusively through a Cloudflare
  **service binding**, forwarding the operator email on every call; api
  rejects any call without an operator identity. A documented dev bypass
  (`AUTHFLEET_DEV_BYPASS=1` plus a dev operator email) exists for local
  development only.
- **Demo mode**: with `AUTHFLEET_DEMO=1`, api serves a fixture project
  with deterministic fake stats so the dashboard can be seen without real
  credentials.
- README documenting architecture, the binding security model, Access
  setup, local dev and the roadmap.

## Out of scope (v1)

- `apps/mcp` (MCP server) — deferred; layout leaves room.
- Write operations against target projects (ban/delete users etc.).
  AuthFleet v1 is read-only toward target projects.
- Combined cross-project totals/graphs (explicitly not required).
- User/role management inside AuthFleet itself (Cloudflare Access owns
  operator auth).
