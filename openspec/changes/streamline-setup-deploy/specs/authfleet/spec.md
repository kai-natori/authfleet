## ADDED Requirements

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
- THEN no migration SQL is reapplied and optional CLI migrations remain compatible

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
reuse its configured name. The root `pnpm run deploy` command SHALL deploy the
API before building and deploying the web Worker without requiring manual remote
migration application.

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
