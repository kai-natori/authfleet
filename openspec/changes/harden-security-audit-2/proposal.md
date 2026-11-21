# Harden security audit round 2

## Why

Registered targets must not consume unbounded dashboard resources. Release
inputs and web server functions also need explicit security boundaries.

## What Changes

- Bound plugin requests to 10 seconds, 1 MiB and 90 daily buckets.
- Require an operator identity before generating plugin keys.
- Install CSRF middleware for dashboard server functions.
- Pin release actions and restrict publishing to main.
- Update the HTTP test fixture dependency and record remaining audit risks.

## Impact

Oversized or stalled plugin responses become typed failures. Cross-site
server-function calls and anonymous key generation are rejected.
