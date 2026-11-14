import type { DailySignup, UserStats } from "./types";

/**
 * Reads a target project's user statistics from its Cloudflare D1
 * database through the Cloudflare D1 HTTP query API.
 *
 * Only SELECT statements are ever issued, and the token used is the
 * project's own read-only token, decrypted by the caller.
 */

export class D1ReadError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "D1ReadError";
    this.code = code;
  }
}

interface D1QueryResponse {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: { results?: Record<string, unknown>[] }[];
}

type FetchFn = typeof fetch;

export interface RemoteD1ReaderOptions {
  accountId: string;
  databaseId: string;
  token: string;
  fetchFn?: FetchFn;
}

const ANON_COLUMNS = ["is_anonymous", "isAnonymous", "is_anon"] as const;

export class RemoteD1Reader {
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor(options: RemoteD1ReaderOptions) {
    this.accountId = options.accountId;
    this.databaseId = options.databaseId;
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      });
    } catch (cause) {
      throw new D1ReadError(
        `Could not reach the Cloudflare D1 API: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const body = (await response.json().catch(() => null)) as D1QueryResponse | null;
    if (!body?.success) {
      const first = body?.errors?.[0];
      throw new D1ReadError(
        first
          ? `D1 query failed (${first.code}): ${first.message}`
          : `D1 query failed: HTTP ${response.status}`,
        first?.code,
      );
    }
    return body.result?.[0]?.results ?? [];
  }

  /** Detect the Better Auth user table: `user` (default) or `users`. */
  async detectUserTable(): Promise<string> {
    const rows = await this.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user', 'users')",
    );
    const names = rows.map((r) => String(r.name));
    if (names.includes("user")) return "user";
    if (names.includes("users")) return "users";
    throw new D1ReadError("No Better Auth user table (`user` or `users`) found in this database.");
  }

  async getUserStats(days = 30): Promise<UserStats> {
    const table = await this.detectUserTable();
    // `table` is one of the two allow-listed names detected above, so
    // interpolating it (quoted) is safe; all values stay bound params.
    const columns = await this.query(`SELECT name FROM pragma_table_info('${table}')`);
    const columnNames = new Set(columns.map((r) => String(r.name)));
    const anonColumn = ANON_COLUMNS.find((c) => columnNames.has(c)) ?? null;

    const totalRows = await this.query(`SELECT COUNT(*) AS n FROM "${table}"`);
    const totalUsers = Number(totalRows[0]?.n ?? 0);

    let anonymousUsers: number | null = null;
    if (anonColumn) {
      const anonRows = await this.query(
        `SELECT COUNT(*) AS n FROM "${table}" WHERE "${anonColumn}" IN (1, '1', 'true')`,
      );
      anonymousUsers = Number(anonRows[0]?.n ?? 0);
    }

    let dailySignups: DailySignup[] = [];
    if (columnNames.has("created_at")) {
      dailySignups = await this.readDailySignups(table, days);
    } else if (columnNames.has("createdAt")) {
      dailySignups = await this.readDailySignups(table, days, "createdAt");
    }

    return { totalUsers, anonymousUsers, dailySignups, asOf: new Date().toISOString() };
  }

  private async readDailySignups(
    table: string,
    days: number,
    column = "created_at",
  ): Promise<DailySignup[]> {
    const probe = await this.query(
      `SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL LIMIT 1`,
    );
    const sample = probe[0]?.v;
    if (sample === undefined || sample === null) return [];

    const now = Date.now();
    let sql: string;
    let cutoff: number | string;
    if (typeof sample === "number") {
      // Epoch: milliseconds are ~1e12, seconds ~1e9.
      const isMillis = sample > 1e11;
      const divisor = isMillis ? 1000 : 1;
      const cutoffMs = now - days * 86_400_000;
      cutoff = isMillis ? cutoffMs : Math.floor(cutoffMs / 1000);
      sql = `SELECT date("${column}" / ${divisor}, 'unixepoch') AS day, COUNT(*) AS n FROM "${table}" WHERE "${column}" >= ? GROUP BY day ORDER BY day ASC`;
    } else {
      // ISO-ish text timestamps: lexicographic cutoff works.
      cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
      sql = `SELECT substr("${column}", 1, 10) AS day, COUNT(*) AS n FROM "${table}" WHERE "${column}" >= ? GROUP BY day ORDER BY day ASC`;
    }
    const rows = await this.query(sql, [cutoff]);
    return rows
      .filter((r) => typeof r.day === "string")
      .map((r) => ({ date: String(r.day), count: Number(r.n ?? 0) }));
  }
}
