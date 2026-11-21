## ADDED Requirements

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
