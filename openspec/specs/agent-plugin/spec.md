# agent-plugin Specification

## Purpose

Define the read-only Better Auth plugin's authenticated counts endpoints,
supported host versions, database adapter access and versioned response contract.

## Requirements

### Requirement: Plugin package and endpoints

The project SHALL publish a Better Auth server plugin (npm package
`authfleet`, factory `authfleet(options)`) that registers read-only GET
endpoints in the `/authfleet` namespace under the target app's Better
Auth base path: `GET /authfleet/validate` and `GET /authfleet/stats`.
The plugin SHALL support Better Auth `>=1.7.16 <2` as a peer dependency.

#### Scenario: Plugin installed in a target app

- WHEN a target app adds `authfleet({ apiKeyHash })` to its Better
  Auth plugins and restarts
- THEN `GET {basePath}/authfleet/validate` responds and no other
  routes, hooks or schema changes are introduced into the app

#### Scenario: Misconfigured plugin

- WHEN the plugin is configured without an API key hash (options and
  env both empty)
- THEN plugin initialization fails loudly at startup instead of
  serving endpoints

### Requirement: Counts-only statistics contract

`GET /authfleet/stats` SHALL return the v1 statistics shape
(`totalUsers`, `dailySignups`, `anonymousUsers`, `asOf`) plus a
contract `version` field, computed from the target app's own data. No
plugin endpoint SHALL return user rows, email addresses, individual
user ids, session data, or any other personally identifiable
information. The `days` parameter SHALL default to 30 and SHALL be
clamped to a maximum of 90.

#### Scenario: Stats for a project with anonymous users

- WHEN the target app's user model has a detectable anonymous flag
  and some users are anonymous
- THEN `anonymousUsers` is their count and `totalUsers` includes them

#### Scenario: Stats without a detectable anonymous flag

- WHEN the target app's user model has no detectable anonymous flag
- THEN stats succeed and `anonymousUsers` is null, never zero

#### Scenario: Response inspected for PII

- WHEN any `/authfleet/*` response body is inspected
- THEN it contains only aggregate counts, dates, the `asOf`
  timestamp and the contract version

### Requirement: Plugin endpoint authentication

Every `/authfleet/*` endpoint SHALL require an
`Authorization: Bearer` API key. The plugin SHALL be configured with
only a SHA-256 hash of the key and SHALL verify presented keys by
hashing them and comparing digests with a timing-safe comparison. The
plugin SHALL NOT log the key or the `Authorization` header, and SHALL
NOT provide any bypass of the key check.

#### Scenario: Missing or wrong key

- WHEN a request to `/authfleet/stats` arrives with no key or a key
  whose hash does not match the configured hash
- THEN the plugin responds 401 with a body that does not reveal which
  check failed

#### Scenario: Correct key

- WHEN a request arrives with the project's API key
- THEN the endpoint responds 200 with the statistics contract

### Requirement: Database-agnostic data access

The plugin SHALL read through the target app's own Better Auth DB
adapter, resolving the user model and its creation-timestamp field as
Better Auth resolves them, so statistics work on any database Better
Auth supports and under schema customization (renamed model or
fields). The plugin SHALL NOT write to the target app's database and
SHALL NOT require database credentials of its own.

#### Scenario: Target app on Postgres with a renamed created-at field

- WHEN the target app runs on Postgres and renames the user model's
  creation-timestamp field
- THEN stats are still computed correctly through the adapter

#### Scenario: Target app database inspected after stats calls

- WHEN stats endpoints have been called repeatedly
- THEN the target app's database shows no writes attributable to the
  plugin (no new tables, columns or rows)

### Requirement: Contract versioning and plugin absence

The statistics contract SHALL carry an integer `version`, starting at
1, versioned independently of the plugin package version. The
dashboard SHALL distinguish at least these states for an `agent`
project: healthy, plugin not found, unreachable, and unsupported
contract version — and SHALL NOT present any of the failure states as
a zero-user project.

#### Scenario: Plugin not installed at the registered base URL

- WHEN the dashboard checks an `agent` project whose base URL has no
  `/authfleet/validate` endpoint
- THEN the project is shown as "plugin not found", not as 0 users

#### Scenario: Plugin newer than the dashboard

- WHEN a plugin returns a contract version higher than any the
  dashboard supports
- THEN the project is shown as a version mismatch prompting a
  dashboard upgrade, and no statistics are fabricated
