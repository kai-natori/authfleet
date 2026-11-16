import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { getAuthTables } from "better-auth/db";
import { isSha256Hex, verifyBearerKey } from "./auth";
import { CONTRACT_VERSION, clampDays, computeStats, type StatsAdapter } from "./stats";

/**
 * AuthFleet agent plugin for Better Auth.
 *
 * Registers two read-only GET endpoints inside the host app, under the
 * app's Better Auth base path:
 *
 *   GET /authfleet/validate → { ok: true, version }
 *   GET /authfleet/stats?days=<n> → counts-only user statistics
 *
 * Security invariants (see README "Threat notes"):
 * - counts only — no user rows, emails, ids or session data, ever;
 * - every endpoint requires the project's API key as a Bearer token,
 *   verified against a stored SHA-256 hash in constant time;
 * - no dev bypass, no logging of key material, no database writes.
 */

export interface AuthfleetOptions {
  /**
   * Hex-encoded SHA-256 of this project's AuthFleet API key. The
   * dashboard shows the key once at registration; only its hash ever
   * reaches the app. Falls back to the `AUTHFLEET_API_KEY_HASH`
   * environment variable.
   */
  apiKeyHash?: string;
}

function envApiKeyHash(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.AUTHFLEET_API_KEY_HASH;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Whether the app's resolved user schema carries an anonymous flag.
 * `getAuthTables` merges core tables, `additionalFields` and every
 * plugin's schema — including the anonymous plugin's `isAnonymous`
 * field — so presence here means the column exists and counting it is
 * meaningful (spike question 3). Any introspection failure is treated
 * as "not detectable" (the stats contract's null), never as zero.
 */
export function detectAnonymousField(options: BetterAuthOptions): boolean {
  try {
    const tables = getAuthTables(options);
    const user = (tables as Record<string, { fields?: Record<string, unknown> }>).user;
    return !!user?.fields && Object.hasOwn(user.fields, "isAnonymous");
  } catch {
    return false;
  }
}

export function authfleet(options: AuthfleetOptions = {}): BetterAuthPlugin {
  // The factory runs synchronously inside the app's betterAuth() call,
  // so throwing here fails startup loudly instead of serving
  // permanently-401 endpoints (spec: misconfigured plugin scenario).
  const apiKeyHash = (options.apiKeyHash ?? envApiKeyHash() ?? "").trim().toLowerCase();
  if (!apiKeyHash) {
    throw new Error(
      "authfleet: no API key hash configured. Pass `apiKeyHash` to the authfleet() plugin or set the AUTHFLEET_API_KEY_HASH environment variable to the hex SHA-256 of your AuthFleet API key. Refusing to start: the stats endpoints must never run unprotected or silently unauthenticated.",
    );
  }
  if (!isSha256Hex(apiKeyHash)) {
    throw new Error(
      "authfleet: apiKeyHash must be the hex-encoded SHA-256 of the API key (64 lowercase hex characters). Generate a key in the AuthFleet dashboard; it shows the hash to paste here.",
    );
  }

  const requireKey = createAuthMiddleware(async (ctx) => {
    if (!(await verifyBearerKey(ctx.headers, apiKeyHash))) {
      // Generic on purpose: never reveal which check failed.
      throw new APIError("UNAUTHORIZED", { message: "unauthorized" });
    }
  });

  async function assertKey(headers: Headers | undefined): Promise<void> {
    // Defence in depth: the plugin middleware above already runs this
    // check for the whole /authfleet namespace; repeating it in the
    // handler keeps the guarantee independent of router middleware
    // matching (spike question 5).
    if (!(await verifyBearerKey(headers, apiKeyHash))) {
      throw new APIError("UNAUTHORIZED", { message: "unauthorized" });
    }
  }

  return {
    id: "authfleet",
    middlewares: [{ path: "/authfleet", middleware: requireKey }],
    endpoints: {
      validate: createAuthEndpoint("/authfleet/validate", { method: "GET" }, async (ctx) => {
        await assertKey(ctx.headers);
        return { ok: true, version: CONTRACT_VERSION };
      }),
      stats: createAuthEndpoint("/authfleet/stats", { method: "GET" }, async (ctx) => {
        await assertKey(ctx.headers);
        const days = clampDays(ctx.query?.days);
        const stats = await computeStats(ctx.context.adapter as unknown as StatsAdapter, {
          days,
          hasAnonymousField: detectAnonymousField(ctx.context.options),
        });
        return stats;
      }),
    },
  };
}

export { isSha256Hex, sha256Hex, timingSafeEqualHex, verifyBearerKey } from "./auth";
export {
  type AuthfleetStats,
  CONTRACT_VERSION,
  clampDays,
  computeStats,
  type DailySignup,
  DEFAULT_DAYS,
  MAX_DAYS,
  STATS_ROW_CAP,
  type StatsAdapter,
} from "./stats";
