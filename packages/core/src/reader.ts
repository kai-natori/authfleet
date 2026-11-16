import type { UserStats } from "./types";

/**
 * The one reader contract both project types satisfy (design:
 * "one reader contract for both types"). Api stats routes, the
 * snapshot job and the dashboard work against this interface only, so
 * `d1` and `agent` projects behave identically above this line.
 *
 * Implementations: `RemoteD1Reader` (Cloudflare D1 HTTP query API) and
 * `HttpAgentReader` (the in-app plugin's HTTP contract).
 */
export interface ProjectStatsReader {
  getUserStats(days?: number): Promise<UserStats>;
}
