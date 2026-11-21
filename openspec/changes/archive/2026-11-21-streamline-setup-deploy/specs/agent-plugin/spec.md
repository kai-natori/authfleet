## MODIFIED Requirements

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
