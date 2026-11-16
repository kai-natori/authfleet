import type { ProjectStatsReader } from "./reader";
import type { DailySignup, UserStats } from "./types";

/**
 * Reads a target project's user statistics from the AuthFleet plugin
 * running inside the target app (`GET {baseUrl}/authfleet/stats`),
 * where `baseUrl` is the app's Better Auth base URL (origin + base
 * path, e.g. `https://example.com/api/auth`).
 *
 * Error discipline mirrors the D1 reader (v1 audit F3): failures are
 * typed by kind so the dashboard can show first-class plugin states
 * (not found / unreachable / version mismatch), `message` is generic,
 * and any upstream detail (status, cause) stays in `detail` for
 * server-side logs only — plugin response bodies are never forwarded
 * to dashboard callers.
 */

export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [1];

export type AgentReadErrorKind =
  | "unreachable"
  | "unauthorized"
  | "not-found"
  | "version-mismatch"
  | "malformed"
  | "upstream";

export class AgentReadError extends Error {
  readonly kind: AgentReadErrorKind;
  /** Server-side diagnostics ONLY (status codes, fetch causes). */
  readonly detail: string | undefined;
  /** The contract version the plugin reported, when it reported one. */
  readonly contractVersion: number | undefined;
  constructor(
    kind: AgentReadErrorKind,
    message: string,
    options?: { detail?: string; contractVersion?: number },
  ) {
    super(message);
    this.name = "AgentReadError";
    this.kind = kind;
    this.detail = options?.detail;
    this.contractVersion = options?.contractVersion;
  }
}

type FetchFn = typeof fetch;

export interface HttpAgentReaderOptions {
  /** The target app's Better Auth base URL (https; http localhost only). */
  baseUrl: string;
  /** The project's plugin API key (decrypted by the caller). */
  apiKey: string;
  fetchFn?: FetchFn;
}

const MAX_DAYS = 90;

/**
 * Base-URL policy for agent projects (design: HTTPS-only, localhost
 * exception mirroring v1 local dev). Returns the URL with trailing
 * slashes removed, or throws a plain Error — a bad base URL is an
 * operator configuration error, surfaced at registration/construction
 * time, not a runtime plugin state.
 */
export function normalizeAgentBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`agent baseUrl is not a valid URL: ${baseUrl}`);
  }
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error(
      "agent baseUrl must use https (http is allowed only for localhost in local development)",
    );
  }
  if (url.username || url.password) {
    throw new Error("agent baseUrl must not contain credentials");
  }
  if (url.search || url.hash) {
    // A query/fragment would end up in the middle of the concatenated
    // endpoint URLs (`{baseUrl}/authfleet/stats`), corrupting every
    // request — reject it at configuration time instead (plugin audit
    // PA3).
    throw new Error("agent baseUrl must not contain a query string or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContractVersion(body: unknown, endpoint: string): number {
  if (!isRecord(body) || typeof body.version !== "number" || !Number.isInteger(body.version)) {
    throw new AgentReadError("malformed", "plugin returned a malformed response", {
      detail: `${endpoint}: missing or non-integer contract version`,
    });
  }
  const version = body.version;
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(version)) {
    throw new AgentReadError(
      "version-mismatch",
      version > Math.max(...SUPPORTED_CONTRACT_VERSIONS)
        ? "plugin is newer than this dashboard — upgrade AuthFleet"
        : "plugin contract version is no longer supported — upgrade the plugin",
      { detail: `${endpoint}: contract version ${version}`, contractVersion: version },
    );
  }
  return version;
}

function parseStatsBody(body: unknown): UserStats {
  const version = parseContractVersion(body, "stats");
  if (!isRecord(body)) {
    throw new AgentReadError("malformed", "plugin returned a malformed response", {
      detail: "stats: body is not an object",
    });
  }
  const { totalUsers, anonymousUsers, dailySignups, asOf } = body;
  if (typeof totalUsers !== "number" || !Number.isInteger(totalUsers) || totalUsers < 0) {
    throw new AgentReadError("malformed", "plugin returned a malformed response", {
      detail: "stats: totalUsers is not a non-negative integer",
      contractVersion: version,
    });
  }
  if (anonymousUsers !== null && (typeof anonymousUsers !== "number" || anonymousUsers < 0)) {
    throw new AgentReadError("malformed", "plugin returned a malformed response", {
      detail: "stats: anonymousUsers is neither null nor a non-negative number",
      contractVersion: version,
    });
  }
  if (!Array.isArray(dailySignups)) {
    throw new AgentReadError("malformed", "plugin returned a malformed response", {
      detail: "stats: dailySignups is not an array",
      contractVersion: version,
    });
  }
  const signups: DailySignup[] = [];
  for (const entry of dailySignups) {
    if (
      !isRecord(entry) ||
      typeof entry.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
      typeof entry.count !== "number" ||
      entry.count < 0
    ) {
      throw new AgentReadError("malformed", "plugin returned a malformed response", {
        detail: "stats: dailySignups entry has an invalid shape",
        contractVersion: version,
      });
    }
    signups.push({ date: entry.date, count: entry.count });
  }
  if (typeof asOf !== "string" || Number.isNaN(Date.parse(asOf))) {
    throw new AgentReadError("malformed", "plugin returned a malformed response", {
      detail: "stats: asOf is not a parseable timestamp",
      contractVersion: version,
    });
  }
  return { totalUsers, anonymousUsers, dailySignups: signups, asOf };
}

export class HttpAgentReader implements ProjectStatsReader {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(options: HttpAgentReaderOptions) {
    this.baseUrl = normalizeAgentBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** GET {baseUrl}/authfleet/validate — used at registration time. */
  async validate(): Promise<{ version: number }> {
    const body = await this.request("/authfleet/validate");
    const version = parseContractVersion(body, "validate");
    if (!isRecord(body) || body.ok !== true) {
      throw new AgentReadError("malformed", "plugin returned a malformed response", {
        detail: "validate: ok is not true",
        contractVersion: version,
      });
    }
    return { version };
  }

  async getUserStats(days = 30): Promise<UserStats> {
    const clamped = Math.min(MAX_DAYS, Math.max(1, Math.floor(days)));
    const body = await this.request(`/authfleet/stats?days=${clamped}`);
    return parseStatsBody(body);
  }

  private async request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
        // Never follow redirects (plugin audit PA1): the operator
        // validated THIS base URL at registration time. A redirect
        // could send the request — from the dashboard's network
        // position — to an origin nobody validated, so a 3xx is an
        // upstream error, not a detour.
        redirect: "manual",
      });
    } catch (cause) {
      throw new AgentReadError("unreachable", "plugin is unreachable", {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new AgentReadError("upstream", "plugin request failed", {
        detail: `HTTP ${response.status} redirect from ${path} (redirects are not followed)`,
      });
    }
    if (response.status === 401) {
      throw new AgentReadError("unauthorized", "plugin rejected the API key", {
        detail: `HTTP 401 from ${path}`,
      });
    }
    if (response.status === 404) {
      throw new AgentReadError("not-found", "plugin not found at this base URL", {
        detail: `HTTP 404 from ${path}`,
      });
    }
    if (!response.ok) {
      throw new AgentReadError("upstream", "plugin request failed", {
        detail: `HTTP ${response.status} from ${path}`,
      });
    }
    return response.json().catch(() => {
      throw new AgentReadError("malformed", "plugin returned a malformed response", {
        detail: `${path}: body is not JSON`,
      });
    });
  }
}
