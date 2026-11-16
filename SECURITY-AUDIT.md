# AuthFleet — Security Audit

- **Scope:** initial commit `d97960b` ("AuthFleet v1 foundation")
- **Date:** 2026-11-15
- **Method:** static code audit of `apps/api`, `apps/web`, `packages/core`,
  wrangler configs, migrations, and tracked-file secrets scan. No live runs,
  no deploys. Existing test suites re-run: **core 17/17 passed, api 11/11
  passed** (apps/web has no test files — see coverage note in §5).
- **Asset under protection:** the registry D1 stores AES-GCM-encrypted
  Cloudflare API tokens for the operator's other projects. Compromise of
  the api's trust boundary = compromise of every registered token.

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 1     |
| Medium   | 2     |
| Low      | 5     |

The cryptography, the response-shape discipline (tokens never leave the
api), the target-D1 SQL construction, and the api's network exposure
config are all sound. The weaknesses concentrate where the design said
they would be watched: **the operator-identity chain (Access header →
web → api gate) is trusted, not verified**, and the shipped web config
does not by itself guarantee that every path to the web Worker passes
through Cloudflare Access.

---

## Findings

### F1 — HIGH: Web trusts the Access email header with no JWT validation, and web does not disable workers.dev

**Evidence**

- `apps/web/src/server/api.ts:45` — the operator identity is taken
  verbatim from the inbound request header and forwarded to the api:

  ```ts
  const fromAccess = request?.headers.get("cf-access-authenticated-user-email");
  if (fromAccess) return fromAccess;
  ```

  There is no validation of `Cf-Access-Jwt-Assertion` anywhere in the
  codebase (grep for `jwt` / `cf-access` across `apps/web/src`,
  `apps/api/src`, `apps/web/worker.mjs` returns only the line above).
- `apps/api/src/app.ts:73-86` — the api accepts **any** non-empty
  `x-authfleet-operator` value (see also F2), so a forged email header
  at web is sufficient for full registry admin: list/create/delete
  projects, read every project's user statistics, trigger snapshots.
- `apps/web/wrangler.jsonc` sets **no** `workers_dev` key, so the
  `*.workers.dev` hostname stays enabled by default. That hostname is
  not covered by a Cloudflare Access application created for the custom
  domain (the setup the README prescribes). On any path that does not
  traverse Access — workers.dev, or a future route added outside the
  Access application — Cloudflare does not inject the header, and a
  remote unauthenticated client can simply set
  `Cf-Access-Authenticated-User-Email: anyone@example.com` itself.
  Web will believe it.

The design doc's claim that the header "cannot be spoofed by a browser"
is true **only** when 100% of traffic to the web Worker traverses
Access. The shipped configuration does not guarantee that invariant;
the code does not check it either.

**Fix**

1. Set `"workers_dev": false` in `apps/web/wrangler.jsonc` (mirror the
   api) and document that web must only be reachable on Access-covered
   hostnames.
2. Defence in depth in web: verify `Cf-Access-Jwt-Assertion` against the
   Access team's JWKS, checking audience (AUD) and expiry, and derive
   the email from the verified JWT — never from the plain header. Fail
   closed when the JWT is absent and the dev bypass is off.

### F2 — MEDIUM: Api operator gate is presence-only; no allowlist, no format check

**Evidence** — `apps/api/src/app.ts:73-86`:

```ts
const operator = c.req.header("x-authfleet-operator");
if (operator) { c.set("operator", operator); return next(); }
```

Any non-empty string (`"x"`, `"not-an-email"`) passes. The gate proves
only "the caller could set a header", which behind the service binding
means "the caller is web". All authorisation strength is delegated to
(a) the binding's network position and (b) web's honesty, plus (c) the
Access policy in front of web. If that Access policy ever admits more
than the owner (a team or whole-domain allow rule is one dashboard edit
away), **every** admitted user receives full admin over the crown-jewels
registry — there is no second check anywhere.

**Fix** — add an api-side allowlist: an `AUTHFLEET_OPERATOR_EMAILS`
secret/var; the gate rejects operators not on it (and non-email-shaped
values). This is a few lines and converts the Access policy from a
single point of failure into one layer of two.

### F3 — MEDIUM: Upstream Cloudflare error details are returned to the caller

**Evidence**

- `packages/core/src/d1-reader.ts` (`query()`, ~lines 76-84) builds
  `D1ReadError` messages from the Cloudflare API's own error payload:
  `D1 query failed (${first.code}): ${first.message}`.
- `apps/api/src/app.ts:174` and `:202` return `cause.message` verbatim
  in the 502 body for the stats and snapshot endpoints; `apps/web`
  (`callApi`) re-throws `body.error`, surfacing it in the dashboard UI.

Today the only caller is the operator, so impact is modest — but the
messages disclose target-account internals (database/table existence,
CF error codes), and **combined with F1 they become available to an
unauthenticated attacker**, turning the stats endpoint into an oracle
for probing registered projects' Cloudflare accounts.

**Fix** — return a generic error (`"failed to read project stats"`)
to the client; log the detailed cause server-side only.

### F4 — LOW: Project config values are interpolated unencoded into the Cloudflare API URL, with format-free validation

**Evidence**

- `apps/api/src/app.ts:46-47, 53-54` — `cfAccountId` and `d1DatabaseId`
  are validated only as strings of length 1-64.
- `packages/core/src/d1-reader.ts:51`:

  ```ts
  const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
  ```

Values containing `/`, `..`, `?`, or `#` reshape the request path.
Scheme and host are hard-coded, so this is **not** general SSRF; the
practical impact is bounded by the stored token's own Cloudflare scope.
It is still an unnecessary hole in the one component that handles every
project's credentials: the project's Bearer token is sent to whatever
path the values produce under `api.cloudflare.com`.

**Fix** — validate formats in the zod schemas (account ID: 32 hex
chars; database ID: UUID shape) and `encodeURIComponent` both segments
when building the URL.

### F5 — LOW: AES-GCM ciphertexts are not bound to their project (no AAD)

**Evidence** — `packages/core/src/crypto.ts:49`:
`crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded)` — no
`additionalData`. Anyone who gains **write** access to the registry D1
(already a serious compromise) can transplant one row's
ciphertext+IV into another project row, causing the api to present
project A's token against project B's database — cross-project token
use and stats confusion that the encryption will happily authenticate.

**Fix** — pass the project id (or accountId+databaseId) as
`additionalData` on encrypt/decrypt. Requires carrying the id through
`encryptText`/`decryptText` call sites; do it before real tokens are
stored, since it is a format change. While there, have `decryptText`
reject IVs that are not 12 bytes (WebCrypto otherwise accepts other
lengths).

### F6 — LOW: "SELECT-only" toward target databases is caller discipline, not enforcement

**Evidence** — `packages/core/src/d1-reader.ts:50`: `query(sql, params)`
is a public method that sends any SQL string to the target D1 with the
project's token. All current internal call sites pass SELECTs (verified
— see §4), so the read-only property rests on (a) no future caller
misusing `query()`, and (b) operators actually creating read-only
tokens, which nothing enforces or verifies.

**Fix** — enforce inside `query()`: reject anything that is not a
single statement starting with `SELECT` (after trimming/comments).
Document in the registration UI/README that the token must be created
with the D1 **Read** permission only.

### F7 — LOW: Brittle production config around the dev bypass and the local API URL

**Evidence**

- `apps/api/wrangler.jsonc` commits `"AUTHFLEET_DEV_BYPASS": "0"` —
  safe as committed, but the bypass branch (`apps/api/src/app.ts:79`)
  activates on the exact string `"1"`, and
  `apps/api/.dev.vars.example` (the file operators copy from) sets
  `AUTHFLEET_DEV_BYPASS=1`. Copying those values into production
  secrets — a plausible operator error — silently opens the bypass.
- `apps/web/wrangler.jsonc` ships `"AUTHFLEET_API_URL":
  "http://127.0.0.1:8788"` in production vars. If the service binding
  is ever missing/misnamed, web's server functions fall back to HTTP
  against loopback instead of failing loudly at startup. (In Workers
  this fetch fails, so it fails closed in practice — but it masks
  misconfiguration.)

**Fix** — keep bypass/demo flags out of committed production vars
entirely (absence = off is already the code's behaviour); remove
`AUTHFLEET_API_URL` from web's production `vars` so a missing binding
is an obvious deployment error, not a silent fallback.

### F8 — LOW (informational): Operator identity is echoed back in API responses

**Evidence** — `apps/api/src/app.ts` (`GET /api/projects`) includes
`operator: c.get("operator")` in the response body, and the dashboard
renders it. It is React-escaped in the UI (no XSS — see §4), but
reflecting an attacker-controllable header value (see F1) into
responses is needless surface. Drop the field, or keep it only as a
display of the _verified_ identity once F1's JWT check exists.

---

## Checked and clean

**Crypto (`packages/core/src/crypto.ts`, `ids.ts`)**

- AES-256-GCM via WebCrypto; key import enforces exactly 32 bytes and
  creates a **non-extractable** key limited to encrypt/decrypt
  (lines 36-42).
- Fresh 96-bit IV from `crypto.getRandomValues` on **every** encryption
  (line 47) — no reuse; covered by the "random IV per record" test.
- Wrong-key decryption fails (GCM tag) — covered by test.
- `generateRandomToken` (line 66-69) is 32 bytes of CSPRNG output,
  base64url — correctly designed for access-granting values. It is
  currently exported-but-unused by production paths; nothing
  secret-bearing uses a ULID instead.
- ULIDs (`newId()`) are used **only** for registry row IDs (projects,
  snapshots) — verified across `apps/api/src/db/repo.ts` and core.
  The demo project's constant id `"demo"` carries empty ciphertext and
  is fenced off from the reader, snapshot, PATCH and DELETE paths in
  `apps/api/src/app.ts`.

**Token exposure discipline**

- `toPublicProject` (`packages/core/src/types.ts`) strips ciphertext
  and IV; the api only ever exposes `tokenHint` (last 4 chars).
- The api test suite asserts the plaintext token appears neither in
  the create response nor in the stored ciphertext.
- The decrypted token exists only in memory in `readerFor()` /
  the cron path and is sent only as an `Authorization: Bearer` header
  to `https://api.cloudflare.com` (hard-coded scheme+host in
  `d1-reader.ts:51` — no SSRF surface via config).
- The only logging in the codebase is the cron failure line
  (`apps/api/src/index.ts:74`): project **name** + error message. No
  token, ciphertext, or key material is logged anywhere (repo-wide
  `console.*` grep).

**Target-D1 SQL construction (`d1-reader.ts`)**

- Table name comes from a `sqlite_master` lookup constrained to the
  allowlist `user` / `users`; the anonymous-flag column from a constant
  allowlist (`is_anonymous`, `isAnonymous`, `is_anon`); the created-at
  column from two hard-coded literals; the epoch divisor is computed
  internally (1 or 1000); the cutoff value is a **bound parameter**.
  No project-config value reaches the SQL text. (The URL path is the
  exception — F4.)

**Registry data layer (`apps/api/src/db/repo.ts`, schema, migration)**

- All Drizzle queries are parameterised (`eq`, `and`); no string-built
  SQL. `deleteProject` removes snapshots explicitly and the migration
  also declares `ON DELETE cascade` with a unique
  `(project_id, date)` index backing the snapshot upsert.

**Exposure & config**

- `apps/api/wrangler.jsonc`: `workers_dev: false`, **no routes**
  (verified), cron trigger only. `/health` is unauthenticated but
  returns only `{ ok, service }`.
- No CORS middleware anywhere on the api; web server functions are
  same-origin.
- Dev bypass fails **closed** in web when no Access header exists and
  the bypass is unset: `operatorEmail()` returns `undefined`, the
  header is omitted, and the api answers 401 (gate behaviour covered
  by api tests).
- `apps/web/worker.mjs` applies `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, and
  `X-Content-Type-Options: nosniff` to every response.
- Snapshot cron has no inbound auth surface (Cloudflare scheduled
  invocation only), isolates per-project failures, and logs no secrets.

**XSS / rendering**

- All dashboard output (project names, operator, stats) renders through
  React JSX with default escaping; repo-wide grep finds no
  `dangerouslySetInnerHTML`, `innerHTML`, or `eval`.

**Secrets hygiene (tracked files)**

- `git grep` scan for secret-shaped assignments across tracked files:
  clean. No `.dev.vars`, `.env`, `dist/`, or `.turbo/` files are
  tracked; `.gitignore` covers them with `!.dev.vars.example` /
  `!.env.example` exceptions only, and the example file contains
  placeholders. Dependency set is small and current-looking
  (hono ^4.13, drizzle-orm ^0.45, zod ^4.6, ulid ^3) — see the
  unverified note on CVE status in §5.

---

## Unverified leads (not findings)

1. **CSRF on web's state-changing server functions**
   (create/delete/snapshot POSTs in `apps/web/src/server/api.ts`).
   No explicit Origin/CSRF check exists in the code. Real protection
   depends on TanStack Start's server-function transport behaviour and
   the `SameSite` attributes of the Cloudflare Access session cookie
   at runtime — not statically verifiable. Recommend a runtime check
   on the operator's machine (cross-site POST attempt while signed in).
2. **Actual deployment state vs. F1** — whether the deployed web
   Worker is in fact reachable via workers.dev, and whether Cloudflare
   strips client-supplied `Cf-Access-*` headers on every route, is a
   deployment fact this static audit cannot settle. F1 is written
   against the shipped config, which does not close the path.
3. **Workers Logs content** — `observability.enabled: true` on both
   Workers. Default invocation logs do not include request headers or
   bodies, but this was not verified against a live deployment; if
   header logging is ever enabled, the Access email and operator
   header become log data.
4. **Cron log detail** — `apps/api/src/index.ts:74` logs the snapshot
   error message, which originates from the Cloudflare D1 API. Whether
   some CF error messages embed SQL fragments could not be confirmed
   without live calls. No credential material is involved either way.
5. **Dependency CVEs** — `pnpm audit` could not be run in the audit
   environment (pnpm unavailable); dependency versions look current
   but their vulnerability status is unverified.
6. **Test coverage gap (web)** — `apps/web` has **zero** test files.
   The most security-sensitive web logic — Access-header reading and
   operator forwarding in `src/server/api.ts` — has no automated
   coverage; the api gate and crypto/reader logic are covered
   (11 + 17 tests, all passing).

---

## Recommended order of work

1. **F1** (web `workers_dev: false` now; Access JWT validation next) —
   this is the only finding that can expose the registry to the
   internet unauthenticated.
2. **F2** (api-side operator allowlist) — cheap, removes the
   single-point-of-failure in the Access policy.
3. **F3 + F4** (generic errors; ID format validation + URL encoding).
4. **F5** before any real production tokens are stored (AAD is a
   ciphertext-format change; free now, a migration later).
5. F6-F8 as hardening when convenient.

---

## Fix status — addendum, 2026-11-15

All findings F1–F8 were fixed at the operator's instruction, before any
real project tokens existed anywhere (so the F5 format change was
free). Verification: core 22/22, api 17/17, web 10/10 tests (baselines
were 17 / 11 / 0; new counts include the tests listed per finding);
typecheck, Biome lint and build green. No live runs, per the house
workflow.

- **F1 — FIXED.** `apps/web/wrangler.jsonc` now sets
  `"workers_dev": false`. Web verifies `Cf-Access-Jwt-Assertion` in
  `apps/web/src/server/access.ts`: RS256 signature against the team
  JWKS (`https://<team>/cdn-cgi/access/certs`, cached in-isolate with a
  refetch on unknown `kid`), issuer, audience and expiry are all
  checked, and the operator email forwarded to api comes from the
  verified claims only — the plain email header is no longer read.
  Config: `AUTHFLEET_ACCESS_TEAM_DOMAIN` + `AUTHFLEET_ACCESS_AUD`;
  setting only one is an error, and with both set a missing/invalid
  JWT throws (fail closed). The dev bypass applies only when Access is
  not configured. Covered by 10 new web unit tests using a generated
  RSA keypair and a stubbed JWKS endpoint (valid, tampered, wrong
  audience/issuer, expired, unknown kid, missing email, malformed,
  wrong alg).
- **F2 — FIXED.** Api gate rejects non-email-shaped operator values
  (401) and, when `AUTHFLEET_OPERATOR_EMAILS` is configured
  (comma-separated, case-insensitive), operators outside the allowlist
  (403). Production wiring parses the env var and logs a one-time
  warning when it is unset while the dev bypass is off. Tests cover
  allowed/denied/shape cases.
- **F3 — FIXED.** Stats and snapshot endpoints return generic errors
  (`failed to read project stats` / `failed to snapshot project`) and
  log the cause server-side. `D1ReadError` now keeps the Cloudflare
  detail in a separate `detail` field (with `code`) for server logs;
  its `message` is generic. The snapshot job includes the detail in its
  (server-side) result strings for cron logging. Tests assert upstream
  codes/messages never appear in response bodies.
- **F4 — FIXED.** Zod schemas require a 32-hex account id and a
  UUID-shaped database id on create and update; the reader
  `encodeURIComponent`s both path segments. Tests cover malformed ids
  (including a path-traversal attempt) and the encoded URL.
- **F5 — FIXED.** `encryptText`/`decryptText` take an AAD context;
  call sites use `projectTokenAad(projectId)` =
  `authfleet:project-token:v1:<id>`. The api generates the project id
  before encrypting at creation (repositories accept a caller-supplied
  id). Decryption rejects non-12-byte IVs. Tests: cross-row transplant
  fails at both core and api level; the owning project still decrypts.
- **F6 — FIXED.** `RemoteD1Reader.query()` enforces single-statement
  SELECT-only via `assertReadOnlyQuery` (leading comments stripped;
  `WITH ... SELECT` allowed after walking the CTE definitions; a
  `WITH` ending in a write is refused) before any network call. Tests
  cover DELETE/UPDATE/INSERT/DROP, multi-statement, and allowed shapes.
- **F7 — FIXED.** `apps/api/wrangler.jsonc` no longer commits any
  `vars` (bypass/demo flags are absent = off; a comment records why),
  and `apps/web/wrangler.jsonc` no longer ships the `127.0.0.1`
  `AUTHFLEET_API_URL` fallback — a missing service binding is now a
  loud deployment error. `.dev.vars.example` remains the local-dev
  source (bypass `1` there is correct and documented as local-only).
- **F8 — FIXED.** `GET /api/projects` no longer includes the operator
  identity (test asserts its absence). The dashboard still displays
  the operator — now sourced from web's own verified identity via
  `getOperatorFn`, i.e. the verified JWT email, which is exactly the
  "display of the verified identity" option this finding suggested.

Observation (not a finding): the pre-existing core test "creates
time-ordered ids" is inherently flaky — `newId()` uses the
non-monotonic `ulid()` factory, so two ids minted in the same
millisecond are randomly ordered and the assertion can fail by chance
(observed once during the fix verification run; the test passes in
isolation). Untouched by these fixes; a monotonic factory or a
relaxed assertion would settle it.

---

## Round 2 — 2026-11-15 (pre-publication)

- **Scope:** the refactored tree after commit `8837905` ("refactor:
  dedupe reader construction and day constants, monotonic ULIDs"),
  audited before the repository is made public. Same areas as round 1
  (crypto, operator gate + Access JWT verification, D1 reader surface,
  registry data layer, wrangler/config, secrets hygiene) plus the new
  code from the F1–F8 fixes and the refactor (`apps/web/src/server/
  access.ts`, `apps/api/src/reader.ts`, monotonic ULIDs), plus a
  pre-publication sweep of every tracked file.
- **Method:** static audit + tracked-file scans (`git grep`) + full
  test suite re-run. No live runs, no deploys.

### Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 1     |

### Findings

#### R2-L1 — LOW: The operator's own product name used as an example in docs/UI

**Evidence** — `README.md` (roadmap) used "how many users does
twiceword have?" as the MCP example, and
`apps/web/src/routes/projects.tsx` used `placeholder="twiceword"` for
the project-name input. "twiceword" is the operator's private product
name; harmless in itself, but a public OSS repository should use
generic examples, and the placeholder would have shipped to every
self-hoster's UI.

**Fix — FIXED in this round.** README example now reads "how many
users does my app have?"; the input placeholder is now "my-app".

### Checked and clean (round 2)

**Access JWT verification (`apps/web/src/server/access.ts`, new since
round 1)** — RS256 only (any other `alg` rejected before key lookup);
signature verified against the team JWKS with a 10-minute in-isolate
cache and exactly one cache-bypassing refetch on unknown `kid`
(rotation); issuer, audience (scalar or array), `exp` and `nbf` all
checked; a JWT without an email claim is rejected. The operator email
forwarded to the api comes only from these verified claims. Web no
longer reads `Cf-Access-Authenticated-User-Email` anywhere (repo-wide
grep). Partial Access configuration (only one of team domain / AUD
set) is a hard error; with Access configured, a missing assertion
throws — fail closed. Covered by 10 unit tests (generated RSA keypair,
stubbed JWKS: valid, tampered, wrong aud/iss, expired, unknown kid,
missing email, malformed, wrong alg).

**Operator gate (api)** — email-shape check, case-insensitive
allowlist with 403 for outsiders, dev bypass inert when Access is
configured on the web side and unset in committed api config
(`apps/api/wrangler.jsonc` commits no `vars` at all). The refactored
`apps/api/src/reader.ts` (single decrypt-and-build path for HTTP and
cron) logs nothing and returns tokens only as the reader's Bearer
credential to the hard-coded Cloudflare host.

**Crypto / ids after the refactor** — AES-GCM with per-project AAD and
12-byte-IV enforcement unchanged; the shared `TextEncoder` extraction
did not alter the wire format (existing transplant/wrong-key tests
pass). `newId()` now uses the ULID monotonic factory: ids remain
lowercase ULIDs used only for row ids, and the previously flaky
ordering test is deterministic (core suite 10/10 repeat runs green).

**Pre-publication sweep (all 73 tracked files)**

- Personal identifiers: `git grep` for the operator's name, email,
  iCloud address, Cloudflare account id, home-directory paths and
  assistant name — **none found**.
- Secret-shaped strings: only obvious test fixtures
  (`cf-token-abcdef9999`, `super-secret-token`, `op@example.com`,
  `0123456789abcdef…` account id, the RFC-example UUID
  `123e4567-e89b-…`). No real credential, account id or database id is
  tracked; the only UUID literal outside tests is Drizzle's internal
  migration-snapshot id.
- `.gitignore` covers `.dev.vars`, `.env*`, `dist/`, `.turbo/`,
  `.wrangler/`; the single tracked example file
  (`apps/api/.dev.vars.example`) contains placeholders only.
- Wrangler configs: api `workers_dev: false` with no routes; web
  `workers_dev: false` with the `API` service binding; registry
  `database_id` in the api config is the all-zeros placeholder.
- Dependency manifests: small, current direct set (hono ^4.13,
  drizzle-orm ^0.45, zod ^4.6, ulid ^3, TanStack Start 1.169,
  React 19.3), fully lockfile-pinned.

### Unverified leads carried over

1. **Dependency CVE status** — `pnpm audit` was attempted again in
   this round; the registry audit endpoint is refused by this
   environment's package-registry policy (`403 policy_denied`), so
   vulnerability status remains unverified here. Run `pnpm audit` on
   the operator's machine before tagging a release.
2. **CSRF posture of web server functions** and **Workers Logs
   content** — runtime properties, unchanged from round 1 §5; verify
   on the operator's machine after the first real deployment.
3. **Deployed reachability** — that the deployed web Worker is only
   reachable on Access-covered hostnames remains a deployment fact to
   confirm at deploy time (the shipped config now closes the
   workers.dev path by construction).

## Plugin audit — 2026-11-16 (add-agent-plugin, tasks group 8)

- **Scope:** the agent-plugin surface added by the `add-agent-plugin`
  change (commits `172d6f7`…`4b5e11c`): `packages/plugin` (endpoint
  auth, counts-only invariant, bucketing cap, factory behaviour),
  `packages/core` `HttpAgentReader` (SSRF surface of operator-supplied
  base URLs, error discipline), `apps/api` agent registration and
  update paths, `apps/web` key generation and plugin-status rendering.
  This round **gates the first npm publish** of the `authfleet`
  package.
- **Method:** static audit of the plugin/core/api/web sources +
  targeted `git grep` scans (logging, Authorization handling, secret
  shapes, personal identifiers across all 101 tracked files) + fixes
  with regression tests + full suite re-run. No live runs, no deploys.

### Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 3 (all fixed in this round) |

### Findings

#### PA1 — LOW: `HttpAgentReader` followed HTTP redirects

**Evidence** — `packages/core/src/agent-reader.ts` called `fetch`
with the default redirect mode. Registration validates the base URL
the operator typed (HTTPS-only, no credentials), but a stats-time
3xx could silently retarget the dashboard's request to an origin
nobody validated — broadening the SSRF surface beyond the validated
URL and letting a compromised target app steer the reader. (Impact
is bounded: the Fetch spec strips `Authorization` on cross-origin
redirects, the deployment is single-operator, and Cloudflare Workers
egress blocks private ranges — hence Low, not Medium.)

**Fix — FIXED in this round.** Requests now use
`redirect: "manual"`, and any 3xx response is mapped to the typed
`upstream` error with the status kept in server-side `detail` only.
Regression test: a stubbed 302 toward a link-local address produces
exactly one request (issued with `redirect: "manual"`) and an
`upstream` error.

#### PA2 — LOW: PATCH updated agent connection settings without the pre-save plugin check

**Evidence** — `POST /api/projects` runs `GET /authfleet/validate`
before saving an `agent` project, but `PATCH /api/projects/:id`
accepted a new `baseUrl` and/or `apiKey` and stored them with no
plugin check at all — a validate-before-save bypass on the update
path. (The check is a typo/consistency guard for a single trusted
operator, not a trust boundary — hence Low.)

**Fix — FIXED in this round.** When a PATCH changes `baseUrl` or
`apiKey`, the api validates the *effective* pair first — a URL-only
change is checked against the stored (decrypted) key, a key-only
change against the stored URL — and a failed check returns 400 and
leaves the project untouched. Name-only updates skip the check.
Regression test covers URL-only failure, key-only failure, stored
record unchanged, and name-only success.

#### PA3 — LOW: Base URLs with a query string or fragment were accepted

**Evidence** — `normalizeAgentBaseUrl` rejected embedded credentials
but accepted `https://app.example.com/api/auth?x=1#frag`. Endpoint
URLs are built by string concatenation (`{baseUrl}/authfleet/stats`),
so the query/fragment landed mid-URL and corrupted every request —
a configuration-time footgun, silently stored.

**Fix — FIXED in this round.** The normaliser now rejects base URLs
carrying a query string or fragment. Regression tests cover both.

### Checked and clean (plugin audit)

**Plugin endpoint auth (`packages/plugin/src/auth.ts`)** — the
plugin stores only the hex SHA-256 of the project key; a presented
Bearer key is hashed and the two fixed-length (32-byte) digests are
compared by a full-length, no-early-exit loop. Both inputs to the
comparison are always well-formed digests (the configured hash is
validated at init; the presented side is a fresh SHA-256), so no
malformed-hex path is reachable. Missing header, wrong scheme and
wrong key all collapse to the same generic `APIError("UNAUTHORIZED",
{ message: "unauthorized" })`. The check runs twice by design — once
as namespace middleware, once inside each handler — so it does not
depend on router middleware matching. No code path in the package
logs: repo-wide grep finds no `console.*` in `packages/plugin/src`,
and the factory's throw messages never interpolate the configured
hash or any presented key.

**Counts-only / PII invariant (plugin)** — by construction, not by
filtering: `computeStats` issues only adapter `count()` calls plus
one `findMany` with `select: ["createdAt"]`, and the response object
is assembled from exactly `{ version, totalUsers, anonymousUsers,
dailySignups, asOf }`. There is no code path that can place a user
row, email or id in a response; the contract suite's PII test
asserts this against the fixture app. The plugin performs no adapter
writes anywhere.

**Bucketing cap and degradation (`packages/plugin/src/stats.ts`)** —
daily buckets are computed only when the window count is
`0 < n ≤ STATS_ROW_CAP (10,000)`; above the cap the response degrades
to totals-only (`dailySignups: []`) with totals still exact, and no
`findMany` is issued. A second guard (`rows.length === windowCount`)
degrades the same way if an adapter silently caps `limit`, so
partial buckets can never be presented as complete. `count()` calls
are aggregates and stay exact at any table size.

**Factory fail-loud behaviour** — `authfleet()` throws synchronously
at `betterAuth()` construction when no hash is configured (option or
`AUTHFLEET_API_KEY_HASH`) or when the hash is not 64 lowercase hex
characters; a misconfigured plugin fails startup instead of serving
permanently-401 or unprotected endpoints. Anonymous-flag detection
failure resolves to `anonymousUsers: null`, never a fabricated zero.

**`HttpAgentReader` URL policy (beyond PA1/PA3)** — HTTPS-only with
an http exception for exactly `localhost` / `127.0.0.1` / `[::1]`;
the WHATWG parser normalises hex/octal IPv4 and compressed IPv6
spellings before the comparison, so those aliases cannot smuggle a
loopback past the check (`localhost.` with a trailing dot does not
match and stays HTTPS-only). Accepted residual, by design: an HTTPS
hostname that *resolves* to a private address is not blocked — the
base URL is operator-supplied in a single-operator deployment, the
credential travels only to that origin over TLS, and Workers egress
blocks private ranges in the deployed topology. Error discipline
(F3) re-verified: plugin response bodies are never forwarded;
`detail` carries only status codes, paths and fetch causes — never
the API key or the Authorization header.

**Api registry (agent branch)** — key length ≥32 enforced
server-side by zod on both create and PATCH (after trimming, so
whitespace padding cannot fake length); creation validates before
saving and stores nothing on failure; the API key is encrypted with
the same AES-GCM + AAD scheme as D1 tokens (`projectTokenAad(id)`)
and is write-only — responses expose only the last-4 `tokenHint`
(asserted by tests, including after rotation). PATCH rejects
foreign-type fields (`token` / `cfAccountId` / `d1DatabaseId` on an
agent project, `apiKey` / `baseUrl` on a d1 project) and type
changes outright; unknown create types are a 400. Error strings for
plugin-check failures are fixed templates per `AgentReadError` kind;
the version-mismatch branch interpolates only AuthFleet's own
generic message, never an upstream body.

**Web key generation and plugin states** — `generateAgentKeyFn`
mints the key with `generateRandomToken(32)` (CSPRNG, base64url,
43 chars) and returns `{ apiKey, apiKeyHash }` to the operator's
browser exactly once; the web Worker never persists or logs it (no
`console.*` in `apps/web/src/server`), and storage happens only in
the api, encrypted, at registration. Like every dashboard server
function it sits behind the Access gate from round 1 (F1). Stats
failures reach the UI as the `ok: false` result union carrying a
whitelisted `pluginStatus` kind (`isPluginStatus` drops anything
unrecognised); a failure state is structurally incapable of
rendering as a zero-user project, which only a successful response
with `totalUsers: 0` can produce.

**Pre-push sweep (all 101 tracked files)** — `git grep` for private
keys, GitHub/npm/cloud token shapes, the operator's real email,
Cloudflare account id, personal domains and home paths: **none
found**. The only secret-shaped strings are the known test fixtures.
`packages/plugin/dist/` is gitignored; the npm tarball contents were
verified separately with `npm pack --dry-run` (see the release-prep
commit).

### Verification (plugin audit round)

- Tests: **106 passed** — core 37, plugin 23, api 28, web 13,
  test-ba14 5 (baseline 103 + 3 new regression tests for PA1–PA3).
- Typecheck 7/7, lint clean (biome, 91 files), build 5/5,
  `openspec validate` strict passes for both changes.

### Unverified leads (plugin audit)

1. **Runtime verification on the operator's Mac** — the fixture app
   plus dashboard against a real non-D1 project (tasks group 8, last
   item) is by design not run in the sandbox; it remains open and is
   the one group-8 item left unchecked.
2. **Dependency CVE status** — unchanged from round 2: `pnpm audit`
   is refused by this environment's registry policy; run it on the
   operator's machine before publishing.
