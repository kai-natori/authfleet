# authfleet — AuthFleet agent plugin for Better Auth

A read-only Better Auth server plugin that lets the self-hosted
[AuthFleet](https://github.com/kai-natori/authfleet) dashboard show a
project's user counts — on **any database Better Auth supports**, not
just Cloudflare D1. Install it in each app you want to see in
AuthFleet; apps on D1 don't need it (AuthFleet reads those directly).

> **Status:** in development, pre-1.0 — not recommended for production
> use yet. The endpoint contract (`version: 1`) may still change.

## Install

```bash
npm install authfleet
```

Requires Better Auth `>=1.4 <2` (peer dependency).

## Configure

Generate a project API key in the AuthFleet dashboard (Projects → Add
project → Plugin). The dashboard shows the key **once** and gives you
its SHA-256 hash. The app only ever receives the **hash**:

```ts
import { betterAuth } from "better-auth";
import { authfleet } from "authfleet";

export const auth = betterAuth({
  // ...your existing config
  plugins: [
    authfleet({
      apiKeyHash: process.env.AUTHFLEET_API_KEY_HASH,
    }),
  ],
});
```

Set the environment variable to the hash from the dashboard:

```bash
AUTHFLEET_API_KEY_HASH=<64 hex characters>
```

You can also compute the hash yourself from a key:

```bash
printf %s "YOUR_API_KEY" | shasum -a 256
```

If the hash is missing or malformed, the plugin **throws at startup**
— by design. A stats endpoint that silently serves 401s forever (or,
worse, no auth) is worse than an app that refuses to boot.

Then register the project in the AuthFleet dashboard with your app's
Better Auth base URL (origin + base path, e.g.
`https://example.com/api/auth`) and the same API key. Registration
verifies the connection against `GET /authfleet/validate` before
saving.

## What it exposes

Two GET endpoints under your Better Auth base path, both requiring
`Authorization: Bearer <api key>`:

| Endpoint                       | Response                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| `GET /authfleet/validate`      | `{ ok: true, version: 1 }` — nothing else                     |
| `GET /authfleet/stats?days=30` | `{ version, totalUsers, anonymousUsers, dailySignups, asOf }` |

`days` defaults to 30 and is clamped to 90. `anonymousUsers` is the
count of anonymous (guest) users when your user schema carries the
anonymous plugin's `isAnonymous` field, and `null` when it does not —
never a fabricated zero.

## Threat notes

- **Counts only.** No endpoint returns user rows, email addresses,
  individual user ids, session data or any other PII. The stats query
  reads aggregate counts and, for daily buckets, the `createdAt`
  column alone (capped at 10,000 values per call; above that the
  response degrades to totals-only rather than scanning your table).
- **Read-only.** The plugin never writes to your database, adds no
  tables or columns, and makes no outbound calls.
- **Hashed key, timing-safe check.** The plugin stores only the
  SHA-256 hash of the API key; a presented key is hashed and the
  digests compared in constant time. Every failure returns the same
  generic 401. Keys are per-project: one leak exposes one project's
  counts endpoint, nothing else.
- **No bypass, no logging.** There is no dev-mode bypass flag — for
  local development, generate a real throwaway key. The key and the
  `Authorization` header are never logged by the plugin.
- **Attack surface** is exactly the two GET endpoints above plus one
  hash comparison, inside your auth server. Protect the dashboard
  side as documented in the main AuthFleet README (HTTPS-only base
  URLs; the key is stored encrypted in the registry).

## Versioning

Three independent versions, by design:

- **Contract version** (`version` field, currently `1`): additive
  changes stay within a version; a breaking change increments it and
  the dashboard keeps reading the previous one for at least one
  AuthFleet release.
- **Package version** (semver, this npm package).
- **Better Auth peer range** (`>=1.4 <2`), tested against 1.4 and 1.7.
