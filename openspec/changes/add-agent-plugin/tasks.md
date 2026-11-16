# Tasks — add-agent-plugin

## 1. Research spike: Better Auth plugin + adapter access

- [x] Verify, against Better Auth 1.4 / 1.5 / 1.6 / 1.7, how a plugin
  endpoint handler reaches the DB adapter from its context, and note
  any per-version differences
- [x] Verify how the user model name and `createdAt` field name are
  resolved when an app customizes its schema (renamed model/fields,
  `additionalFields`), and what init-time schema introspection exists
- [x] Verify how an anonymous-flag field can be detected through the
  adapter/schema (anonymous plugin present vs. absent)
- [x] Determine whether per-day signup counts can be computed through
  the adapter within safe bounds (row/window caps); if not on some
  version, record the totals-only degradation from design.md
- [x] Verify endpoint path composition under a custom Better Auth
  `basePath`, and a single auth check covering all `/authfleet/*`
  routes
- [x] Verify plugin init behaviour on missing `apiKeyHash` (fail loud
  at startup) and record all findings in design.md / a linked spike
  note — group 2 does not start until this group is written up

## 2. Plugin package (packages/plugin)

- [ ] Package scaffold: name `authfleet`, Better Auth peer dependency
  `>=1.4 <2`, build + typecheck + lint wired into turbo
- [ ] `authfleet(options)` factory: `apiKeyHash` from options, falling
  back to `AUTHFLEET_API_KEY_HASH`; missing hash fails at init
- [ ] `GET /authfleet/validate` → `{ ok: true, version: 1 }`, no data
- [ ] `GET /authfleet/stats` → v1 `UserStats` shape + `version`,
  `days` param (default 30, clamped to 90), counts only
- [ ] Bearer-key check on all endpoints: SHA-256 of the presented key,
  timing-safe comparison against the configured hash, generic 401
- [ ] Stats computed through the app's Better Auth DB adapter (user
  model as resolved by Better Auth); anonymous split or `null`
- [ ] No logging of the key or `Authorization` header; no dev bypass;
  no writes to the host app's database
- [ ] Package README: install, config, key generation, threat notes
  (attack surface, counts-only promise)

## 3. Contract tests + fixture app

- [ ] Fixture Better Auth app on a **non-D1 database** (Postgres or
  SQLite via a non-Cloudflare adapter) with the plugin installed —
  proves DB-agnosticism end to end
- [ ] Contract tests against the fixture: validate/stats response
  shapes match the recorded contract v1 exactly
- [ ] Auth tests: missing key → 401, wrong key → 401, correct key →
  200; key never appears in fixture app logs
- [ ] Custom-schema fixture variant (renamed user model / `createdAt`
  field) still returns correct stats, per spike findings
- [ ] Version matrix: fixture suite runs against Better Auth 1.4 and
  1.7 at minimum (1.5/1.6 if the spike found differences)
- [ ] PII test: stats response contains no user rows, emails or ids

## 4. Core: HttpAgentReader (packages/core)

- [ ] Formalize the `ProjectStatsReader` interface in core;
  `RemoteD1Reader` declared as implementing it (no behaviour change)
- [ ] `HttpAgentReader`: `{ baseUrl, apiKey }`, calls
  `GET {baseUrl}/authfleet/stats?days=<n>` with Bearer key over
  https (localhost http allowed), validates contract `version`
  against the supported set
- [ ] Error mapping: unreachable / 401 / version mismatch / malformed
  body produce distinct typed errors whose detail stays server-side
  (v1 audit F3 discipline — plugin error bodies never forwarded)
- [ ] Unit tests with a stubbed fetch: happy path, each error class,
  contract-version handling (known, older, newer-than-supported)

## 5. Registry + API (apps/api)

- [ ] Migration: `projects.type` (`'d1' | 'agent'`, backfill `'d1'`)
  and nullable `baseUrl`; `cfAccountId` / `d1DatabaseId` become
  nullable for `agent` rows
- [ ] Core registry types updated (`ProjectRecord`, `PublicProject`,
  create/update data): `type` + `baseUrl` exposed, per-type fields
  omitted when not applicable; credential columns and AES-GCM + AAD
  encryption reused unchanged
- [ ] Creation/update validation branches on type: `d1` keeps v1
  format rules; `agent` requires https base URL (localhost exception
  in dev) and an API key of ≥32 characters
- [ ] `agent` registration performs `GET /authfleet/validate` before
  saving; failure returns a specific registration error
- [ ] Reader construction branches on project type in the stats
  routes and the snapshot job; snapshot behaviour unchanged
- [ ] API tests: registry CRUD for both types, key write-only (only
  last-4 hint returned), stats for an `agent` project via a stubbed
  reader, snapshot job over mixed-type projects

## 6. Web (apps/web)

- [ ] Add-project form: project-type selector; `d1` fields (account
  id, database id, Cloudflare token) vs. `agent` fields (base URL,
  API key) with per-type help text and the plugin install snippet
- [ ] Registration flow for `agent`: offer a generated API key (shown
  once) plus its SHA-256 hash to paste into the app config
- [ ] Project list + switcher: type badge (`D1` / `Plugin`)
- [ ] Plugin status states on list and detail: not found /
  unreachable / version mismatch shown distinctly from real stats
  and from a genuine zero-user project
- [ ] Existing `d1` flows unchanged

## 7. Docs

- [ ] README: plugin install + registration instructions, updated
  architecture notes (two connection models), roadmap line for the
  plugin as the decided v2 adapter
- [ ] `openspec/project.md`: record the second connection model and
  the plugin's counts-only / read-only invariants
- [ ] Plugin versioning policy documented (contract version vs.
  package version vs. Better Auth peer range)

## 8. Security audit round 2 (gates first npm publish)

- [ ] Audit the plugin package: auth check (hash comparison, timing),
  no-bypass, no logging of key material, no PII in responses, no DB
  writes, failure behaviour on misconfiguration
- [ ] Audit the new dashboard-side surface: `HttpAgentReader` (SSRF
  surface of operator-supplied base URLs, error leakage), registry
  type branching, key generation/storage for `agent` projects
- [ ] Findings written to `SECURITY-AUDIT.md` (round 2 section) and
  fixes applied before the plugin is published to npm
- [ ] Unit tests / typecheck / lint / build run and recorded
- [ ] Runtime verification on the operator's Mac (fixture app +
  dashboard against a real non-D1 project) — by design not done in
  CI/sandbox
