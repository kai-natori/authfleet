# authfleet Specification

## Purpose

Define the self-hosted dashboard's project registry, counts and snapshots,
credential protection, operator identity, and Cloudflare deployment behavior.

## Requirements

### Requirement: Project registry

The system SHALL register, list, update and delete `d1` and `agent` projects
using the fields required for each type. Before saving an agent project, it
SHALL verify connectivity and contract version via `GET /authfleet/validate`
and refuse registration with a specific error if that check fails.

#### Scenario: Register a project

- WHEN the operator submits a new project with all fields required
  for its type
- THEN the project is stored with a lowercase ULID id and a `type`,
  and appears in the project list without its credential being shown

#### Scenario: D1 registration fields

- WHEN an operator registers a `d1` project
- THEN registration requires its name, Cloudflare account id, D1 database id
  and Cloudflare API token

#### Scenario: Agent registration fields

- WHEN an operator registers an `agent` project
- THEN registration requires its name, Better Auth base URL and project API key
- AND the plugin's connectivity and contract version are checked before saving

#### Scenario: Token is write-only

- WHEN any project is read back through the API
- THEN the response contains no credential value (Cloudflare token or
  plugin API key), only a last-4 hint

#### Scenario: Agent registration with an unreachable plugin

- WHEN the operator registers an `agent` project whose base URL does
  not answer `GET /authfleet/validate`
- THEN registration is refused with an error naming the connectivity
  problem, and no project row is stored

### Requirement: Encrypted credentials

Stored project API tokens SHALL be encrypted at rest with AES-GCM
(WebCrypto) using a key from a Worker secret, and SHALL never be logged
or returned in plaintext. The ciphertext SHALL be bound to its project
row via AES-GCM additional authenticated data (the project id in a
versioned context string), so a ciphertext transplanted into another
project's row SHALL NOT decrypt.

#### Scenario: Stored row inspected directly

- WHEN the registry D1 `projects` row is read raw
- THEN only ciphertext, IV and a last-4 hint are present

#### Scenario: Ciphertext transplanted across rows

- WHEN one project's ciphertext and IV are copied into another
  project's row and that project is read
- THEN decryption fails and no statistics are returned for it

### Requirement: User statistics per project

For the selected project, the system SHALL report total users, daily signups
from creation timestamps and new users over 7 and 30 days. The anonymous count
SHALL be the guest count when an anonymous flag exists, otherwise null.
Both readers SHALL implement `ProjectStatsReader` in `packages/core`, giving
both project types consistent statistics, snapshots and dashboard behavior.

#### Scenario: Project without anonymous column

- WHEN the target user data has no anonymous-flag field or column
- THEN stats succeed and the anonymous field is null

#### Scenario: D1 project statistics

- WHEN a `d1` project is selected
- THEN its statistics are read through the Cloudflare D1 HTTP query API

#### Scenario: Agent project statistics

- WHEN an `agent` project with a healthy plugin is selected
- THEN the dashboard shows the same statistics layout as for a `d1`
  project, sourced from the plugin endpoint
- AND `HttpAgentReader` calls `GET /authfleet/stats` over HTTPS with the
  project's API key

### Requirement: Daily snapshots and growth

The api Worker SHALL, on a daily schedule, record each registered
(non-demo) project's total user count into a `snapshots` table, at most
one row per project per day, and the dashboard SHALL show growth derived
from those snapshots.

#### Scenario: Cron runs twice in one day

- WHEN the snapshot job runs a second time on the same day
- THEN the existing snapshot for that day is updated, not duplicated

### Requirement: Project switching (no combined totals)

The dashboard SHALL present one selected project at a time, chosen via a
project switcher. Combined totals across projects are NOT required.

#### Scenario: Switch project

- WHEN the operator picks another project in the switcher
- THEN all stats on the page refer to the newly selected project

### Requirement: Api is reachable only via service binding

Both Workers SHALL be deployed with `workers_dev = false`; the api
Worker SHALL have no routes, and web SHALL call it only through a
Cloudflare service binding. Every api call SHALL carry the operator
identity, which web SHALL derive from the VERIFIED Cloudflare Access
JWT (`Cf-Access-Jwt-Assertion`) — never from the plain email header.
Api SHALL reject calls without an email-shaped operator identity and
SHALL NOT echo the identity in responses.

#### Scenario: Call without operator identity

- WHEN an api route is called with no operator header and the dev
  bypass is off
- THEN the call is rejected with 401

#### Scenario: Operator outside the allowlist

- WHEN the api allowlist (`AUTHFLEET_OPERATOR_EMAILS`) is configured
  and an api route is called with an operator identity outside it
- THEN the call is rejected with 403

#### Scenario: Dev bypass versus Access

- WHEN Access verification is configured on web
- THEN the local-development bypass has no effect, and a missing or
  invalid Access JWT fails closed; the bypass SHALL never be enabled
  in production

### Requirement: Demo mode

With demo mode enabled, the system SHALL present a fixture project with
deterministic fake statistics so the dashboard can be evaluated without
real credentials.

#### Scenario: Demo project selected

- WHEN demo mode is on and the fixture project is selected
- THEN stats render from fixture data and no outbound D1 query is made

### Requirement: Automatic registry migrations

The API SHALL statically bundle registry SQL and apply pending migrations before
API requests and scheduled jobs. It SHALL cache initialization per isolate and
database, reset on failure, and track filenames in Wrangler-compatible
`d1_migrations`. Each migration and history insert SHALL use one D1 batch.

#### Scenario: Concurrent completion

- WHEN another isolate completes a migration while this isolate attempts it
- THEN a batch failure is accepted only after re-reading history confirms completion

#### Scenario: Fresh or partially migrated registry

- WHEN the registry has no history or only an initial subset of migrations
- THEN only pending migrations are applied in filename order before serving API work

#### Scenario: Existing CLI history

- WHEN all bundled migrations have Wrangler-style history rows
- THEN no migration SQL is reapplied and Wrangler migration history remains compatible

#### Scenario: Failed migration

- WHEN migration application fails without a concurrent completion
- THEN the API returns a generic 503, logs details server-side, and retries on a later request
- AND `/health` remains unaffected

### Requirement: Required operator allowlist

The API SHALL reject every `/api/*` request with 503 when the operator allowlist
is unset or empty unless the explicit local development bypass is enabled. It
SHALL log missing configuration once per isolate. Configured allowlists SHALL
continue to reject unlisted operators with 403.

#### Scenario: Missing production allowlist

- WHEN the allowlist is missing and local development bypass is disabled
- THEN even an email-shaped operator identity receives a configuration 503

#### Scenario: Local development

- WHEN explicit local development bypass is enabled
- THEN an absent allowlist does not prevent local API use

### Requirement: Provisioned one-command deployment

The registry binding SHALL omit a fixed database ID so Wrangler can provision or
reuse its configured name. The root `pnpm run deploy` command SHALL build the
workspace, deploy the API, configure missing secrets, and then deploy the web
Worker without requiring manual remote migration application.

#### Scenario: First deployment

- WHEN an operator runs the documented deployment command with required credentials
- THEN the named registry is provisioned or reused and schema setup is automatic

### Requirement: Trusted plugin publishing and supported host versions

Plugin publishing SHALL use GitHub Actions npm trusted publishing with supported
Node and npm versions and OIDC permissions, without a long-lived publish token.
The Better Auth peer range SHALL be `>=1.7.16 <2`.

#### Scenario: Release workflow

- WHEN the configured trusted workflow publishes a release
- THEN npm authenticates with OIDC and the package requires Better Auth 1.7.16 or newer within 1.x

### Requirement: Documented setup and updates

The README SHALL document provisioning, automatic migration regeneration and
application, required security configuration, one-command deployment, trusted
publishing, and the procedure for updating an existing installation.

#### Scenario: Existing installation update

- WHEN an operator follows the README update procedure
- THEN they can deploy updated code with pending migrations without a mandatory manual remote migration step

### Requirement: Bounded agent responses

The dashboard SHALL apply a 10-second deadline covering each plugin fetch
and response body, consume at most 1 MiB of response bytes, and accept at
most 91 daily signup buckets, including both boundary UTC dates of a
90-day rolling window. Violations SHALL produce generic typed
errors without forwarding upstream content.

#### Scenario: Stalled target

- WHEN a plugin request or body exceeds the deadline
- THEN the read is aborted and reported as an unreachable plugin

#### Scenario: Oversized response

- WHEN a plugin body exceeds 1 MiB or contains more than 91 daily buckets
- THEN the read fails as a malformed plugin response

#### Scenario: Rolling window crosses 91 UTC dates

- WHEN a valid 90-day plugin response includes both boundary UTC dates
- THEN all 91 daily signup buckets are accepted

#### Scenario: Empty signup series

- WHEN a valid plugin response contains no daily signup buckets
- THEN the dashboard accepts its counts without fabricating buckets

### Requirement: Server-function security gates

Plugin key generation SHALL require an operator identity resolved using
the same verified Access identity rules as other dashboard operations.
Dashboard server functions SHALL use TanStack Start CSRF middleware.

#### Scenario: Missing identity

- WHEN an anonymous caller requests a plugin key without local dev bypass
- THEN no key is generated and the request fails

#### Scenario: Cross-site server-function request

- WHEN a server-function request fails the CSRF middleware policy
- THEN the handler is not executed

### Requirement: Reviewed release inputs

The npm publish job SHALL run only on main and SHALL pin external
GitHub Actions to full commit SHAs.

#### Scenario: Non-main workflow dispatch

- WHEN the publish workflow is dispatched on another branch
- THEN the publish job is skipped
