# AuthFleet — spec delta (v1)

## ADDED Requirements

### Requirement: Project registry

The system SHALL let an operator register Better Auth projects with a
name, Cloudflare account id, D1 database id and a Cloudflare API token,
and SHALL list, update and delete registered projects.

#### Scenario: Register a project

- WHEN the operator submits a new project with all four fields
- THEN the project is stored with a lowercase ULID id and appears in the
  project list without its token being shown

#### Scenario: Token is write-only

- WHEN any project is read back through the API
- THEN the response contains no token value, only a last-4 hint

### Requirement: Encrypted credentials

Stored project API tokens SHALL be encrypted at rest with AES-GCM
(WebCrypto) using a key from a Worker secret, and SHALL never be logged
or returned in plaintext.

#### Scenario: Stored row inspected directly

- WHEN the registry D1 `projects` row is read raw
- THEN only ciphertext, IV and a last-4 hint are present

### Requirement: User statistics per project

For a selected project the system SHALL read the project's D1 through
the Cloudflare D1 HTTP query API and report total users, signups per day
derived from `created_at`, and new users in the last 7 and 30 days. When
the `user` table has an anonymous flag column, the system SHALL also
report the anonymous (guest) count; when it does not, that field SHALL be
absent rather than zero.

#### Scenario: Project without anonymous column

- WHEN the target `user` table has no `is_anonymous`-style column
- THEN stats succeed and the anonymous field is null

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

The api Worker SHALL be deployed with `workers_dev = false` and no
routes; the web Worker SHALL call it only through a Cloudflare service
binding. Every api call SHALL carry the operator identity forwarded from
Cloudflare Access (`Cf-Access-Authenticated-User-Email` via web), and
api SHALL reject calls without an operator identity, except under the
local-development bypass flag which SHALL never be enabled in
production.

#### Scenario: Call without operator identity

- WHEN an api route is called with no operator header and the dev
  bypass is off
- THEN the call is rejected with 401

### Requirement: Demo mode

With demo mode enabled, the system SHALL present a fixture project with
deterministic fake statistics so the dashboard can be evaluated without
real credentials.

#### Scenario: Demo project selected

- WHEN demo mode is on and the fixture project is selected
- THEN stats render from fixture data and no outbound D1 query is made
