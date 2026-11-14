# AGENTS.md — AuthFleet

Self-hosted multi-project dashboard for Better Auth apps. Read `README.md`
for the product/security model and `openspec/` for behaviour contracts.

## Layout

| Path            | What                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`      | Hono Worker. Registry, stats, snapshot cron. **No public exposure** (`workers_dev: false`, no routes) — web reaches it only via service binding. Migrations in `apps/api/migrations`. |
| `apps/web`      | TanStack Start + shadcn/ui dashboard behind Cloudflare Access. Server-side api client in `src/server/api.ts`.                                                                         |
| `packages/core` | Framework-free logic: ids, crypto, remote D1 reader, registry contract, stats, snapshots, demo fixtures.                                                                              |
| `apps/mcp`      | Deferred. Do not create without a new OpenSpec change.                                                                                                                                |

## Non-negotiables

1. **Tokens**: project Cloudflare API tokens are stored AES-GCM-encrypted
   only, never returned by the api, never logged. IDs are lowercase
   ULIDs; secrets never are.
2. **Operator identity**: every `/api/*` call needs `x-authfleet-operator`
   (forwarded Access email), except `/health`. The dev bypass
   (`AUTHFLEET_DEV_BYPASS`) is local-only.
3. **Read-only toward targets**: core issues `SELECT`s only against
   target D1 databases.
4. **Specs before behaviour changes**: add/update an OpenSpec change,
   then implement.

## Commands

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
pnpm spec:validate
```

Dev verification convention: unit tests / typecheck / lint / build only —
no e2e, screenshots or deploys from agents; runtime checks happen on the
operator's machine.
