# AuthFleet

**One dashboard for all your Better Auth apps — self-hosted on Cloudflare.**

Register several of your own Better Auth projects and switch between them
in one dashboard to see each project's user counts and growth. AuthFleet
is open source and runs entirely in your own Cloudflare account.

Why: Better Auth's official Infrastructure dashboard is a hosted SaaS
(not open source), and the OSS admin UI (Better Auth Studio) is embedded
per app. Nobody offered a self-hosted, multi-project switcher — so this
exists.

## Architecture

```
                Cloudflare Access (operator login)
                            │
                            ▼
┌──────────────────────────────┐   service binding   ┌──────────────────────────────┐
│ apps/web                     │ ──────────────────▶ │ apps/api                     │
│ TanStack Start + shadcn/ui   │   (no public path)  │ Hono Worker                  │
│ - project switcher           │                     │ - workers_dev = false        │
│ - verifies the Access JWT    │                     │ - no routes / no domain      │
│   and forwards the operator  │                     │ - daily snapshot cron        │
│   email on every api call    │                     │                              │
└──────────────────────────────┘                     └──────────────┬───────────────┘
                                                                  │
                                          registry D1 (Drizzle)   │  Cloudflare D1 HTTP
                                          - projects (token is    │  query API, per-project
                                            AES-GCM encrypted)    │  read-only token
                                          - snapshots             ▼
                                                    target projects' D1 databases
                                                    (Better Auth `user` table counts)
```

- `apps/api` — Hono on Workers. Registry CRUD, stats, and the scheduled
  snapshot job. Holds every credential; therefore it is **not public**
  (see the security model).
- `apps/web` — TanStack Start dashboard behind Cloudflare Access.
- `packages/core` — framework-free logic shared by both: lowercase-ULID
  ids, AES-GCM credential encryption (WebCrypto), the remote D1 reader,
  stats math, the snapshot job, demo fixtures.
- `apps/mcp` — planned, not built yet (see Roadmap).

Data per project: total users in the Better Auth `user` table, signups
per day from `created_at`, new users (7d / 30d), the anonymous/guest
count when the table has an `is_anonymous`-style column, and growth from
daily snapshots taken by the api cron. Switching projects is the core
interaction; combined cross-project totals are intentionally out of
scope for v1.

## Security model

Read this before deploying — AuthFleet stores credentials for your other
projects, so its own posture matters.

- **Api has no public exposure.** `apps/api/wrangler.jsonc` sets
  `workers_dev: false` and defines **no routes**. The only way in is the
  Cloudflare **service binding** from `apps/web`
  (`services: [{ binding: "API", service: "authfleet-api" }]`).
  Service-binding calls never traverse the public internet. Web also
  sets `workers_dev: false`, so it is only reachable on the custom
  domain your Access application covers.
- **Operator identity is verified, then required on every api call.**
  Web verifies the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`)
  against your team JWKS — signature, audience and expiry — and
  forwards the email **from the verified claims** as
  `x-authfleet-operator`. The plain
  `Cf-Access-Authenticated-User-Email` header is never trusted (it is
  spoofable wherever a request reaches the Worker without traversing
  Access). Configure verification with `AUTHFLEET_ACCESS_TEAM_DOMAIN`
  and `AUTHFLEET_ACCESS_AUD` on the web Worker; when Access is
  configured, a missing or invalid JWT fails closed. Api rejects
  `/api/*` calls without an email-shaped operator identity with 401,
  and — when `AUTHFLEET_OPERATOR_EMAILS` is set on the api Worker
  (comma-separated; **set it in production**) — rejects anyone outside
  that allowlist with 403, whatever the Access policy admits. The api
  does not echo the operator identity in responses.
- **Tokens are encrypted at rest.** Each project's Cloudflare API token
  is encrypted with AES-GCM (WebCrypto, 256-bit key from the
  `TOKEN_ENCRYPTION_KEY` Worker secret, random IV per record) before it
  touches D1. The ciphertext is additionally bound to its project row
  via AES-GCM AAD, so a ciphertext copied into another project's row
  does not decrypt. The API never returns a token — only a last-4
  hint — and tokens are never logged.
- **Tokens should be read-only.** Register each project with a
  Cloudflare API token scoped to D1 read for that one database.
  AuthFleet core enforces single-statement `SELECT`-only queries in
  code (not just by convention), so it cannot mutate a target project
  even by accident.
- **Errors don't leak upstream detail.** When a target read fails, api
  returns a generic error to the dashboard; Cloudflare's error codes
  and messages stay in server-side logs only.
- **IDs are not secrets.** Row ids are lowercase ULIDs; anything that
  grants access uses high-entropy randomness, never a ULID.
- **Dev bypass is local-only.** `AUTHFLEET_DEV_BYPASS=1` makes api accept
  calls without an Access identity (using `AUTHFLEET_DEV_OPERATOR`).
  It exists so `wrangler dev` works on your machine. It is inert
  whenever Access verification is configured on web, and neither
  Worker's committed config contains the flag. **Never set it in
  production.**

## Stack

pnpm monorepo · Hono · TanStack Start · shadcn/ui (Base UI base,
neutral) · Cloudflare Workers + D1 · Drizzle ORM · Biome · Vitest ·
Turbo · OpenSpec (`openspec/`) — specs before behaviour changes.

## Local development

Prerequisites: Node ≥ 22, pnpm 10.

```bash
pnpm install

# 1. api (terminal A)
cd apps/api
cp .dev.vars.example .dev.vars   # set TOKEN_ENCRYPTION_KEY (openssl rand -base64 32)
pnpm db:migrate:local            # creates the local registry D1
pnpm dev                         # wrangler dev on http://127.0.0.1:8788

# 2. web (terminal B)
cd apps/web
AUTHFLEET_DEV_BYPASS=1 AUTHFLEET_API_URL=http://127.0.0.1:8788 pnpm dev
# → http://127.0.0.1:3000
```

`.dev.vars.example` enables demo mode (`AUTHFLEET_DEMO=1`) by default, so
the dashboard shows a fixture project ("Demo — Acme") with deterministic
fake data before you register any real project.

Checks: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`,
`pnpm spec:validate`.

## Deployment sketch

(One-command deploy for both Workers is a roadmap item; today it is two
deploys in this order.)

1. Create the registry D1 and put its id in `apps/api/wrangler.jsonc`,
   then `pnpm --filter @authfleet/api db:migrate:remote` and
   `pnpm --filter @authfleet/api deploy`. Set the encryption key:
   `wrangler secret put TOKEN_ENCRYPTION_KEY` in `apps/api`, and set
   the operator allowlist: `wrangler secret put AUTHFLEET_OPERATOR_EMAILS`
   (your email; comma-separated if several). Do **not** set
   `AUTHFLEET_DEV_BYPASS` here — the committed config deliberately omits
   the flag entirely.
2. Deploy web: `pnpm --filter @authfleet/web build && pnpm --filter @authfleet/web deploy`.
   The web Worker's wrangler config already binds `API` to
   `authfleet-api` via a service binding, and disables `workers.dev`
   so web is only reachable on its custom domain.
3. Put web behind **Cloudflare Access** (Zero Trust → Access →
   Applications): create a self-hosted application for the web Worker's
   domain, with an allow policy for your email only. Access is the login
   system — AuthFleet deliberately builds no auth of its own.
4. Tell web how to verify Access JWTs: set two vars on the web Worker —
   `AUTHFLEET_ACCESS_TEAM_DOMAIN` (e.g. `your-team.cloudflareaccess.com`)
   and `AUTHFLEET_ACCESS_AUD` (the audience tag shown on your Access
   application's overview). Without them web cannot establish the
   operator identity and the api will answer 401 (fail closed).

## Roadmap

- `apps/mcp`: a read-only MCP server over the same core (ask your AI
  "how many users does twiceword have?") — deferred from v1 by design.
- One-command deploy for both Workers.
- Optional write actions per project (ban/delete) behind explicit
  confirmation — only if demand appears; v1 is read-only by design.
