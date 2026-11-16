/**
 * Statistics computation for the plugin's `/authfleet/stats` endpoint.
 *
 * Everything goes through the host app's Better Auth DB adapter with
 * LOGICAL model/field names (`model: "user"`, fields `createdAt` /
 * `isAnonymous`): the adapter resolves them to the app's physical
 * table and column names, which is what makes the plugin work on any
 * database and under schema customisation (see the research spike in
 * openspec/changes/add-agent-plugin/spike.md, questions 2–4).
 *
 * Counts only: this module reads aggregate counts and, for the daily
 * buckets, the `createdAt` column alone. It never selects user rows,
 * emails or ids, and it never writes.
 */

/** The endpoint contract version. Independent of the package version. */
export const CONTRACT_VERSION = 1;

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;

/**
 * Hard cap on created-at values fetched for bucketing in one stats
 * call (spike question 4). Above it the response degrades to
 * totals-only (`dailySignups: []`) with totals still exact, so a stats
 * call can never become an unbounded scan of the host app's user
 * table.
 */
export const STATS_ROW_CAP = 10_000;

const DAY_MS = 86_400_000;

export interface StatsWhere {
  field: string;
  value: string | number | boolean | Date | null;
  operator?: "eq" | "gte";
}

/** The structural subset of Better Auth's DBAdapter the plugin uses. */
export interface StatsAdapter {
  count(data: { model: string; where?: StatsWhere[] }): Promise<number>;
  findMany(data: {
    model: string;
    where?: StatsWhere[];
    limit?: number;
    select?: string[];
    sortBy?: { field: string; direction: "asc" | "desc" };
  }): Promise<Record<string, unknown>[]>;
}

export interface DailySignup {
  /** YYYY-MM-DD (UTC) */
  date: string;
  count: number;
}

/** Byte-for-byte the dashboard-side `UserStats` shape, plus `version`. */
export interface AuthfleetStats {
  version: number;
  totalUsers: number;
  /** null when the user model has no detectable anonymous flag. */
  anonymousUsers: number | null;
  dailySignups: DailySignup[];
  /** ISO timestamp of when the stats were read. */
  asOf: string;
}

/** Contract rule: default 30 days, clamped to [1, 90]. */
export function clampDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DAYS;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(n)));
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export interface ComputeStatsOptions {
  days: number;
  /**
   * Whether the resolved user schema carries an anonymous flag
   * (`isAnonymous`), resolved by the caller via schema introspection.
   * When false, `anonymousUsers` is null — never a fabricated zero.
   */
  hasAnonymousField: boolean;
  now?: Date;
}

export async function computeStats(
  adapter: StatsAdapter,
  options: ComputeStatsOptions,
): Promise<AuthfleetStats> {
  const now = options.now ?? new Date();
  const totalUsers = await adapter.count({ model: "user" });

  let anonymousUsers: number | null = null;
  if (options.hasAnonymousField) {
    anonymousUsers = await adapter.count({
      model: "user",
      where: [{ field: "isAnonymous", value: true }],
    });
  }

  const cutoff = new Date(now.getTime() - options.days * DAY_MS);
  const windowWhere: StatsWhere[] = [{ field: "createdAt", operator: "gte", value: cutoff }];
  const windowCount = await adapter.count({ model: "user", where: windowWhere });

  let dailySignups: DailySignup[] = [];
  if (windowCount > 0 && windowCount <= STATS_ROW_CAP) {
    const rows = await adapter.findMany({
      model: "user",
      where: windowWhere,
      select: ["createdAt"],
      limit: windowCount,
      sortBy: { field: "createdAt", direction: "asc" },
    });
    // An adapter that silently caps `limit` would otherwise produce
    // partial buckets presented as complete; degrade instead (spike
    // question 4). Totals above stay exact either way.
    if (rows.length === windowCount) {
      const buckets = new Map<string, number>();
      for (const row of rows) {
        const createdAt = toDate(row.createdAt);
        if (!createdAt) continue;
        const date = createdAt.toISOString().slice(0, 10);
        buckets.set(date, (buckets.get(date) ?? 0) + 1);
      }
      dailySignups = [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));
    }
  }

  return {
    version: CONTRACT_VERSION,
    totalUsers,
    anonymousUsers,
    dailySignups,
    asOf: now.toISOString(),
  };
}
