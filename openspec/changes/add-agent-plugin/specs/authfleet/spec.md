# AuthFleet — spec delta (agent plugin)

<!-- Archive order: archive `add-authfleet-v1` first — its
     specs/authfleet/spec.md is the base these MODIFIED requirements
     apply to. -->

## MODIFIED Requirements

### Requirement: Project registry

The system SHALL let an operator register Better Auth projects of two
types and SHALL list, update and delete registered projects. A `d1`
project registers with a name, Cloudflare account id, D1 database id
and a Cloudflare API token. An `agent` project registers with a name,
the target app's Better Auth base URL and the plugin API key for that
project; before an `agent` project is saved, the system SHALL verify
connectivity and contract version via the plugin's
`GET /authfleet/validate` endpoint and SHALL refuse registration with a
specific error when that check fails.

#### Scenario: Register a project

- WHEN the operator submits a new project with all fields required
  for its type
- THEN the project is stored with a lowercase ULID id and a `type`,
  and appears in the project list without its credential being shown

#### Scenario: Token is write-only

- WHEN any project is read back through the API
- THEN the response contains no credential value (Cloudflare token or
  plugin API key), only a last-4 hint

#### Scenario: Agent registration with an unreachable plugin

- WHEN the operator registers an `agent` project whose base URL does
  not answer `GET /authfleet/validate`
- THEN registration is refused with an error naming the connectivity
  problem, and no project row is stored

### Requirement: User statistics per project

For a selected project the system SHALL report total users, signups
per day derived from the user creation timestamp, and new users in the
last 7 and 30 days, regardless of project type: for `d1` projects by
reading the project's D1 through the Cloudflare D1 HTTP query API, and
for `agent` projects by calling the plugin's `GET /authfleet/stats`
endpoint in the target app (via `HttpAgentReader`, over HTTPS, with
the project's API key). When the user data has an anonymous flag, the
system SHALL also report the anonymous (guest) count; when it does
not, that field SHALL be absent rather than zero. Both reader
implementations SHALL satisfy the same `ProjectStatsReader` contract
in `packages/core`, so statistics, snapshots and the dashboard behave
identically for both types.

#### Scenario: Project without anonymous column

- WHEN the target user data has no anonymous-flag field or column
- THEN stats succeed and the anonymous field is null

#### Scenario: Agent project statistics

- WHEN an `agent` project with a healthy plugin is selected
- THEN the dashboard shows the same statistics layout as for a `d1`
  project, sourced from the plugin endpoint
