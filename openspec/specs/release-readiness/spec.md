# release-readiness Specification

## Purpose

Define data-preserving upgrades, verified operator forwarding, release and
deployment checks, and accurate reporting of verification and publication status.

## Requirements

### Requirement: Preserve existing registry data

The runtime migration runner SHALL preserve projects, encrypted credentials and
snapshots when applying the legacy project-table rebuild. Data preservation and
migration history SHALL commit in the same batch. Distributed SQL SHALL remain
unchanged.
The unsafe remote CLI migration shortcut SHALL be removed; upgrades SHALL use
the runtime runner, which includes the compatibility preservation step.

#### Scenario: Upgrade a populated v1 registry

- WHEN a registry with migration 0000 has projects and snapshots
- THEN applying pending runtime migrations retains every project and snapshot
- AND a failed batch leaves the old data and history intact for a retry

### Requirement: Verified operator forwarding

Web SHALL derive the operator forwarded through the API service binding from
verified Access JWT claims and SHALL stop before calling the API when Access
verification fails or is partially configured.

#### Scenario: Spoofed identity

- WHEN a request supplies a plain Access email header that differs from the JWT
- THEN the forwarded operator is the verified JWT email

### Requirement: Checked releases and deployments

Publishing SHALL require successful typecheck, unit tests, lint, build, strict
spec validation and a production dependency audit. The HTTP end-to-end fixture
SHALL remain outside automated unit verification. Publishing SHALL use OIDC from
main with no long-lived npm token.

#### Scenario: Failed check

- WHEN any required check fails
- THEN the dependent publishing or Cloudflare deployment job does not run

#### Scenario: Optional continuous deployment

- WHEN the operator enables deployment and provides the documented credentials
- THEN a main push deploys through the same one-command deployment script
- AND deployments are serialized

### Requirement: Accurate release and validation status

The plugin SHALL advance to 0.2.0 for the minimum Better Auth version change.
Documentation SHALL distinguish implemented controls, completed verification and
external configuration still requiring operator input.

#### Scenario: Missing external configuration

- WHEN Cloudflare credentials, domain configuration or npm trust are unavailable
- THEN the release record identifies the exact outstanding step without marking
  deployment or publication complete
