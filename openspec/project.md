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
- DB: Cloudflare D1 + Drizzle. Row IDs are lowercase ULIDs.
- `apps/mcp` — deferred (not in v1); the layout leaves room for it.

## Security invariants

- Stored project credentials (Cloudflare API tokens) are encrypted at rest
  with AES-GCM (WebCrypto); the key comes from a Worker secret
  (`TOKEN_ENCRYPTION_KEY`). Tokens are never stored in plaintext and never
  logged.
- Project API tokens are read-only (D1 read) by instruction and by design:
  core only ever issues `SELECT` queries against target databases.
- The api Worker has `workers_dev = false` and no routes. The only caller
  is the web Worker via a service binding. Every api call must carry the
  operator identity (the Cloudflare Access authenticated email forwarded
  by web); calls without it are rejected. A dev bypass exists for local
  development only and must never be enabled in production.
