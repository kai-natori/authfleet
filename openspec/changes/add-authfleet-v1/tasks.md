# Tasks — add-authfleet-v1

## 1. Scaffold

- [x] pnpm monorepo root (package.json, pnpm-workspace.yaml, turbo.json,
  biome.json, tsconfig.base.json, .gitignore)
- [x] packages/core skeleton with subpath-free single entry
- [x] apps/api skeleton (Hono Worker, wrangler.jsonc with
  `workers_dev: false`, no routes, D1 binding, cron trigger)
- [x] apps/web skeleton (TanStack Start + Tailwind v4 + shadcn/ui,
  wrangler.jsonc with API service binding)

## 2. Core (packages/core)

- [x] Lowercase ULID `newId()`
- [x] AES-GCM encrypt/decrypt (WebCrypto), random token generator
- [x] Remote D1 reader (Cloudflare D1 HTTP query API): table/column
  probing, total users, per-day signups, anonymous split
- [x] Registry repository contract + in-memory implementation
- [x] Stats math (7d/30d windows, snapshot growth) and snapshot job
- [x] Demo fixture project + deterministic demo stats
- [x] Unit tests for crypto, reader, stats, snapshot job

## 3. API (apps/api)

- [x] Drizzle schema (projects, snapshots) + generated migration
- [x] Drizzle-backed repository implementing the core contract
- [x] Operator-identity middleware (binding header + dev bypass)
- [x] Routes: health, projects CRUD (token write-only), stats, history,
  manual snapshot
- [x] Scheduled handler running the snapshot job
- [x] Route tests with in-memory repository + fake reader

## 4. Web (apps/web)

- [x] Server-side api client: service binding in production,
  `AUTHFLEET_API_URL` HTTP in local dev; forwards operator email
- [x] Dashboard route: project switcher, total users, new 7d/30d,
  anonymous split (when available), daily signups, snapshot growth
- [x] Projects route: list, add project form, delete
- [x] shadcn/ui components via CLI, Biome-formatted

## 5. Docs & verification

- [x] README (architecture, binding security model, Access setup,
  local dev, security model, roadmap)
- [x] Unit tests / typecheck / lint run and recorded
- [ ] Runtime verification on the operator's Mac (dev servers, Access
  policy, real project registration) — by design not done in CI/sandbox
