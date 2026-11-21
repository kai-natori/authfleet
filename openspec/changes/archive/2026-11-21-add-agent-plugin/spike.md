# Research spike — Better Auth plugin + adapter access

Answers to the six open questions in design.md ("Research spike
required"), verified 2026-11-16 against the **published npm packages**
`better-auth` / `@better-auth/core` at 1.4.22, 1.5.6, 1.6.34 and
1.7.25 (the latest release of each minor line in the supported range
`>=1.4 <2`), plus the official plugin documentation
(better-auth.com/docs/concepts/plugins and the repo's
`docs/content/docs/concepts/plugins.mdx`). Package type definitions
and shipped JS were read directly; version-specific file references
below are to `@better-auth/core` unless noted.

## 1. Reaching the DB adapter from a plugin endpoint

**Answer: `ctx.context.adapter` — identical on 1.4, 1.5, 1.6, 1.7.**

A handler created with `createAuthEndpoint` receives better-call's
endpoint context extended with `context: AuthContext`
(`AuthEndpointContext`, `dist/context/endpoint-context.d.mts` in every
version checked). `AuthContext` carries:

- `adapter: DBAdapter<Options>` (`dist/types/context.d.mts`:
  1.4.22 line 142, 1.5.6 line 198, 1.6.34 line 241, 1.7.25 line 273)
- `internalAdapter: InternalAdapter<Options>`
- `options: BetterAuthOptions` (the app's full resolved options)

The official plugin docs say the same: inside `ctx`, `context` gives
access to `options`, `db`, `adapter` ("orm like functions… we
recommend using this over `db`") and `internalAdapter`.

The `DBAdapter` surface the plugin needs is also stable across the
range (checked in full on 1.4.22 and 1.7.25,
`dist/db/adapter/index.d.mts`):

```ts
count(data: { model: string; where?: Where[] }): Promise<number>
findMany<T>(data: {
  model: string;
  where?: Where[];
  limit?: number;
  offset?: number;
  select?: string[];
  sortBy?: { field: string; direction: "asc" | "desc" };
}): Promise<T[]>
// Where = { field: string; value: ...; operator?: "eq" | "ne" | "lt"
//   | "lte" | "gt" | "gte" | "in" | ...; connector?: "AND" | "OR" }
```

There is **no per-version difference** that affects this change. The
plugin uses `adapter` only (never `internalAdapter`, whose user
helpers are write-oriented, and never `db`/Kysely, which would break
DB-agnosticism for non-Kysely adapters).

## 2. User model / `createdAt` resolution under schema customisation

**Answer: the plugin passes logical names only — `model: "user"`,
fields `"createdAt"` / `"isAnonymous"` — and never needs the physical
names.**

Callers of the adapter always use the logical model key and logical
field names. Proof from core's own code: `internalAdapter`'s
`countTotalUsers` calls `adapter.count({ model: "user", where })`
(better-auth `dist/db/internal-adapter.mjs`, 1.4.22 line 110).
Adapters receive core-supplied resolvers — `getModelName`,
`getFieldName`, `getDefaultModelName`, `schema` (kysely adapter
factory signature, better-auth `dist/adapters/kysely-adapter/`) — and
translate logical names to the physical table/columns themselves.

The customisation points that feed those resolvers (all in
`BetterAuthOptions`, `dist/types/init-options.d.mts`):

- `user.modelName` — physical user table name (default `"user"`)
- `user.fields` — map of logical field name → physical column name
  (e.g. `createdAt: "created_at"`)
- `user.additionalFields` — extra fields added to the resolved schema

So a renamed model, a renamed `createdAt` column, and additional
fields all work with zero plugin configuration.

**Init-time schema introspection exists**: `getAuthTables(options)`
returns the fully resolved `BetterAuthDBSchema`, keyed by logical
model key (`tables.user.fields`, with each table's physical name in
its `modelName` property). It merges core tables, `additionalFields`
and **all plugin-contributed schemas** (the reduce over
`options.plugins` in `dist/db/get-tables.mjs`, present in 1.4.22 and
1.7.25). It is exported from `@better-auth/core/db` and re-exported
by `better-auth/db` (`export * from "@better-auth/core/db"`). The
plugin calls it at request time with `ctx.context.options` (cheap,
pure function of options) rather than caching at init.

## 3. Anonymous-flag detection

**Answer: detect the resolved schema field `isAnonymous` on the user
model; count through the adapter when present, return `null` when
absent.**

The anonymous plugin (id `"anonymous"`) contributes exactly this
field through its plugin schema — identical in 1.4.22, 1.5.6, 1.6.34
and 1.7.25 (better-auth `dist/plugins/anonymous/schema.mjs`):

```ts
{ user: { fields: { isAnonymous: {
  type: "boolean", required: false, input: false, defaultValue: false,
} } } }
```

Detection: `getAuthTables(options).user.fields` has an own
`isAnonymous` key. This is true exactly when the anonymous plugin is
installed (its schema is merged by `getAuthTables`) or the app
declared an equivalent field itself — both cases mean the column
exists and counting `where: [{ field: "isAnonymous", value: true }]`
is meaningful. When the key is absent the plugin returns
`anonymousUsers: null`, per the v1 rule (never a fabricated zero).
This mirrors v1's D1 column probing, one level up (resolved schema
instead of `pragma_table_info`).

## 4. Per-day signup counts: efficiency and safe bounds

**Answer: computable on every supported version, by in-memory
bucketing under a hard row cap; the totals-only degradation applies
when the cap is exceeded (an operational bound, not a version one).**

The adapter has **no aggregation or group-by** in any of 1.4–1.7 —
only `count` and `findMany` (interface checked in full on 1.4.22 and
1.7.25). So per-day counts are computed as:

1. `windowCount = adapter.count({ model: "user", where:
   [{ field: "createdAt", operator: "gte", value: cutoff }] })`
   where `cutoff = now - days * 86_400_000` and `days` is the
   contract's clamped window (≤ 90).
2. If `windowCount > ROW_CAP` (10,000), degrade: return
   `dailySignups: []` with `totalUsers` (and the anonymous split)
   still exact. This is the design's recorded totals-only fallback,
   triggered by volume rather than by version.
3. Otherwise fetch only the timestamp column:
   `findMany({ model: "user", where, select: ["createdAt"],
   limit: windowCount, sortBy: { field: "createdAt",
   direction: "asc" } })` and bucket by UTC day in memory.
   Adapter field-type conversion returns `createdAt` as a JS `Date`
   (field type `"date"`), so bucketing is `toISOString().slice(0,10)`
   after a `Date` coercion guard for adapters that return strings or
   epoch numbers.
4. If the fetched row count differs from `windowCount` (an adapter
   that silently caps `limit`), degrade the same way instead of
   returning partial buckets as if they were complete.

Cost bound per stats call: 2–3 adapter queries plus at most 10,000
single-column rows in memory. No unbounded scan is possible: the
window is ≤ 90 days and the row cap is checked with a `count` before
any rows are fetched.

## 5. Path composition under a custom `basePath`; one auth check

**Answer: plugin paths are relative to the app's Better Auth
`basePath`; no plugin code is involved. A single plugin middleware
covers the whole `/authfleet` namespace, and each handler re-checks
as defence in depth.**

- `BetterAuthOptions.basePath` (default `"/api/auth"`,
  `dist/types/init-options.d.mts` in all four versions) is where the
  auth router mounts every endpoint, core and plugin alike. A plugin
  endpoint created as `createAuthEndpoint("/authfleet/stats", …)` is
  served at `{basePath}/authfleet/stats` whatever `basePath` the app
  configured. The dashboard therefore registers the app's full auth
  base URL (origin + basePath) as the project's `baseUrl`, exactly as
  design.md specifies.
- Plugins may declare `middlewares: { path: string; middleware }[]`
  (`BetterAuthPlugin` type, `dist/types/plugin.d.mts`, all versions).
  `getEndpoints` collects them into the router (better-auth
  `dist/api/index.mjs`: the `options.plugins?.map((plugin) =>
  plugin.middlewares…)` block is present and equivalent in 1.4.22 and
  1.7.25). The plugin registers one entry,
  `{ path: "/authfleet", middleware: requireAuthfleetKey }`, so the
  Bearer check runs for the whole namespace before any handler.
- Defence in depth: each handler also invokes the same check function
  first thing, so the guarantee does not rest solely on router
  middleware-matching semantics.

## 6. Init behaviour on missing `apiKeyHash` — fail loud at startup

**Answer: throw synchronously in the plugin factory.**

The factory `authfleet(options)` executes inside the app's
`betterAuth({ plugins: [...] })` call, i.e. at process startup, before
any request is served. Resolving the hash (option →
`AUTHFLEET_API_KEY_HASH` env fallback) and validating it there means:

- missing/empty hash → `throw new Error("authfleet: … set apiKeyHash
  or AUTHFLEET_API_KEY_HASH …")` — the app fails to boot, which is
  the loud failure the spec requires ("plugin initialization fails
  loudly at startup instead of serving endpoints");
- a hash that is not a 64-character hex string (SHA-256 hex) → same
  treatment, since it can never match a presented key and would
  otherwise degrade to permanent 401s.

The plugin `init(ctx)` hook (present in `BetterAuthPlugin` on all
versions) is not needed for this: factory-time validation is earlier
and simpler. Nothing is logged beyond the thrown error, and the error
message never contains key material (there is none yet — only the
hash was expected).

## Consequences for group 2

- Imports (verified in the 1.4.22 package): `createAuthEndpoint`,
  `createAuthMiddleware` from `better-auth/api`; `getAuthTables`
  from `better-auth/db`; type `BetterAuthPlugin` from the
  `better-auth` root. All exist across 1.4–1.7.
- Stats implementation uses only `adapter.count` / `adapter.findMany`
  with logical names; anonymous detection via `getAuthTables`.
- Per-day bucketing cap: `ROW_CAP = 10_000` created-at values per
  stats call; above it, totals-only degradation (`dailySignups: []`),
  on all versions.
- Auth: one plugin middleware on path `/authfleet` + in-handler
  re-check; hash validated in the factory.
