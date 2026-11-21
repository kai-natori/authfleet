# AGENTS.md — AuthFleet

Self-hosted multi-project dashboard for Better Auth apps. Read `README.md`
for the product/security model and `openspec/` for behaviour contracts.

## Layout

| Path                     | What                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`               | Hono Worker. Registry, stats, snapshot cron. **No public exposure** (`workers_dev: false`, no routes) — web reaches it only via service binding. Migrations in `apps/api/migrations`.         |
| `apps/web`               | TanStack Start + shadcn/ui dashboard behind Cloudflare Access. Server-side api client in `src/server/api.ts`.                                                                                 |
| `packages/core`          | Framework-free logic: ids, crypto, remote D1 reader, plugin HTTP reader (`HttpAgentReader`), registry contract, stats, snapshots, demo fixtures. Both readers implement `ProjectStatsReader`. |
| `packages/plugin`        | The `authfleet` npm package: read-only, counts-only Better Auth plugin for target apps (contract v1). Never log key material; no dev bypass; no DB writes.                                    |
| `packages/test-ba-floor` | Version-matrix cell: the plugin contract suite against the supported Better Auth floor, 1.7.16 (vitest aliases bind the plugin source to those modules).                                      |
| `packages/test-e2e`      | True end-to-end suite: a Hono host app mounting Better Auth + the plugin, served over real HTTP (@hono/node-server), exercised by raw fetch and core's `HttpAgentReader`.                     |
| `apps/mcp`               | Deferred. Do not create without a new OpenSpec change.                                                                                                                                        |

## Non-negotiables

1. **Tokens**: project Cloudflare API tokens are stored AES-GCM-encrypted
   only, never returned by the api, never logged. IDs are lowercase
   ULIDs; secrets never are.
2. **Operator identity**: every `/api/*` call needs `x-authfleet-operator`,
   except `/health`. Web derives it from the **verified** Cloudflare
   Access JWT (`apps/web/src/server/access.ts`) — never from the plain
   email header — and api enforces the `AUTHFLEET_OPERATOR_EMAILS`
   allowlist as required configuration (503 when absent outside local dev bypass).
   The dev bypass (`AUTHFLEET_DEV_BYPASS`)
   is local-only and inert when Access verification is configured.
3. **Read-only toward targets**: core issues `SELECT`s only against
   target D1 databases; the plugin only counts through the host app's
   adapter and never writes. Project credentials (D1 tokens, plugin
   API keys) share one AES-GCM + AAD storage scheme; the API key is
   write-only exactly like the token.
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
