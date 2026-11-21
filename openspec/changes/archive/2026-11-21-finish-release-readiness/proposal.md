# Finish release readiness

## Why

The merged dashboard has automatic migrations, but the published plugin still
uses the old host-version range. Release checks and deployment automation need
to enforce the current contracts. Historical audit and roadmap text obscures
which operator checks remain outstanding.

The legacy project-table rebuild also needs a populated-registry regression
test: D1 batches cannot disable foreign keys, so dropping the old parent table
can cascade-delete snapshots during an upgrade.

## What changes

- Preserve snapshots atomically while the runtime runner applies legacy migration
  `0001`, without rewriting already distributed migration SQL.
- Check operator identity forwarding through the web service binding.
- Gate publishing and optional Cloudflare deployment on repository checks.
- Release plugin 0.2.0 with the supported Better Auth floor of 1.7.16.
- Reconcile documentation and audit status with code and actual validation.
- Patch the two transitive development-tool advisories with narrowly scoped
  overrides and verify the affected tooling.

## Impact

The plugin's minimum supported host version is a pre-1.0 breaking change.
Cloudflare domain and Access policy configuration remains installation-specific.
Live validation and npm trust configuration must not be reported complete until
they are actually verified.
