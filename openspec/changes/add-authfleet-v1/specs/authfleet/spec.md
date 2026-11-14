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
