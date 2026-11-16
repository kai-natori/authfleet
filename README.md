# AuthFleet

**English** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

> **⚠️ In development — not recommended for production use.** AuthFleet is
> pre-1.0 and under active development. APIs and data formats may change
> without notice. Use it for evaluation and self-hosted experiments; do not
> rely on it for production authentication data yet.

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
                                          - projects (credential  │  query API, per-project
                                            AES-GCM encrypted)    │  read-only token
                                          - snapshots             ▼
                                                    target projects' D1 databases  (d1 projects)
                                                    (Better Auth `user` table counts)
                                                                  │  HTTPS + per-project
                                                                  │  Bearer API key
                                                                  ▼
                                                    target apps running the plugin  (agent projects)
                                                    (counts served by the app itself, any database)
```

- `apps/api` — Hono on Workers. Registry CRUD, stats, and the scheduled
  snapshot job. Holds every credential; therefore it is **not public**
  (see the security model).
- `apps/web` — TanStack Start dashboard behind Cloudflare Access.
- `packages/core` — framework-free logic shared by both: lowercase-ULID
  ids, AES-GCM credential encryption (WebCrypto), the remote D1 reader,
  the plugin HTTP reader, stats math, the snapshot job, demo fixtures.
  Both readers implement one `ProjectStatsReader` contract, so stats,
  snapshots and the dashboard behave identically for both project types.
- `packages/plugin` — the `authfleet` npm package: a read-only Better
  Auth plugin for target apps (see "Connecting a project" below).
- `apps/mcp` — planned, not built yet (see Roadmap).

Data per project: total users in the Better Auth `user` table, signups
per day from the creation timestamp, new users (7d / 30d), the
anonymous/guest count when the user data has an anonymous flag, and
growth from daily snapshots taken by the api cron. Switching projects
is the core interaction; combined cross-project totals are intentionally
out of scope.

## Connecting a project

There are two connection types; choose per project when you register it.

**D1 projects** (the app uses Cloudflare D1): register the Cloudflare
account id, the D1 database id, and a Cloudflare API token scoped to
D1 read for that one database. Nothing changes in the target app.

**Plugin projects** (any other database — Postgres, MySQL, SQLite, …):
install the AuthFleet plugin in the target app. It serves the same
counts through two read-only endpoints inside the app, reading through
the app's own Better Auth DB adapter, so it works on any database
Better Auth supports.

```bash
npm install authfleet
```

```ts
import { betterAuth } from "better-auth";
import { authfleet } from "authfleet";

export const auth = betterAuth({
  plugins: [
    authfleet({
      apiKeyHash: process.env.AUTHFLEET_API_KEY_HASH,
    }),
  ],
});
```

Generate a project API key in the dashboard (Projects → Add project →
Plugin → "Generate a key"). The dashboard shows the key **once** and
gives you its SHA-256 hash: set `AUTHFLEET_API_KEY_HASH` to that hash
in the app's environment — the app only ever holds the hash, never the
key. Then register the project with the app's Better Auth base URL
(origin + base path, e.g. `https://example.com/api/auth`) and the same
key. Registration calls the plugin's `GET /authfleet/validate` before
saving, so a wrong URL or key fails immediately with a specific error.

The plugin is **counts-only and read-only**: no endpoint returns user
rows, emails or ids; it never writes to the app's database; and there
is no dev-mode bypass (use a real throwaway key locally). Full details
and threat notes: `packages/plugin/README.md`.

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
- **Credentials are encrypted at rest.** Each project's credential —
  the Cloudflare API token for `d1` projects, the plugin API key for
  `agent` projects — is encrypted with AES-GCM (WebCrypto, 256-bit key
  from the `TOKEN_ENCRYPTION_KEY` Worker secret, random IV per record)
  before it touches D1. The ciphertext is additionally bound to its
  project row via AES-GCM AAD, so a ciphertext copied into another
  project's row does not decrypt. The API never returns a credential —
  only a last-4 hint — and credentials are never logged.
- **Reads are read-only on both paths.** Register each `d1` project
  with a Cloudflare API token scoped to D1 read for that one database;
  AuthFleet core enforces single-statement `SELECT`-only queries in
  code (not just by convention), so it cannot mutate a target project
  even by accident. The `agent` plugin is read-only and counts-only by
  design, and the target app holds only a SHA-256 hash of its key,
  which the plugin compares in constant time.
- **Agent base URLs are HTTPS-only** (plain HTTP is accepted only for
  localhost in local development), registration verifies the plugin
  before saving, and a project whose plugin is absent, unreachable or
  on an unsupported contract version is shown as that distinct state —
  never as a zero-user project.
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

- **Agent plugin**: implemented (`packages/plugin`, endpoint contract
  v1, tested against Better Auth 1.4 and 1.7) — the remaining step is
  the round-2 security audit, which gates the first npm publish.
- `apps/mcp`: a read-only MCP server over the same core (ask your AI
  "how many users does my app have?") — deferred from v1 by design.
- One-command deploy for both Workers.
- Optional write actions per project (ban/delete) behind explicit
  confirmation — only if demand appears; v1 is read-only by design.

## Releasing

The npm packages are published from GitHub Actions, never from a local
machine. The **Publish to npm** workflow (`.github/workflows/publish.yml`)
is dispatched manually and takes the `NPM_TOKEN` repository secret — a
granular npm access token with publish rights for `authfleet` and
`auth-fleet` and 2FA bypass enabled. This includes the first publish of
both packages.

- Choose `plugin` to build and publish `authfleet` (`packages/plugin`)
  with provenance.
- Choose `nameguard` to publish `auth-fleet` (`packages/nameguard`), the
  name-guard placeholder. It is published once and never updated.
- Choose `both` to publish the two in one run.
