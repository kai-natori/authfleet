import { describe, expect, it } from "vitest";
import { D1ReadError, RemoteD1Reader } from "../src/d1-reader";

interface ScriptStep {
  match: string;
  rows: Record<string, unknown>[];
}

function fakeFetch(steps: ScriptStep[], calls: { sql: string }[]) {
  return async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string };
    calls.push({ sql: body.sql });
    const step = steps.find((s) => body.sql.includes(s.match));
    if (!step) throw new Error(`unscripted query: ${body.sql}`);
    return {
      status: 200,
      json: async () => ({ success: true, errors: [], result: [{ results: step.rows }] }),
    } as Response;
  };
}

function reader(steps: ScriptStep[], calls: { sql: string }[]) {
  return new RemoteD1Reader({
    accountId: "acct",
    databaseId: "db",
    token: "test-token",
    fetchFn: fakeFetch(steps, calls) as typeof fetch,
  });
}

describe("RemoteD1Reader", () => {
  it("reads totals, anonymous split and daily signups (epoch ms)", async () => {
    const calls: { sql: string }[] = [];
    const r = reader(
      [
        { match: "sqlite_master", rows: [{ name: "user" }] },
        {
          match: "pragma_table_info",
          rows: [{ name: "id" }, { name: "created_at" }, { name: "is_anonymous" }],
        },
        // Order matters: more specific statements first.
        {
          match: "GROUP BY day",
          rows: [
            { day: "2026-11-14", n: 3 },
            { day: "2026-11-15", n: 5 },
          ],
        },
        { match: 'COUNT(*) AS n FROM "user" WHERE', rows: [{ n: 40 }] },
        { match: 'COUNT(*) AS n FROM "user"', rows: [{ n: 120 }] },
        { match: "LIMIT 1", rows: [{ v: 1762000000000 }] },
      ],
      calls,
    );
    const stats = await r.getUserStats(30);
    expect(stats.totalUsers).toBe(120);
    expect(stats.anonymousUsers).toBe(40);
    expect(stats.dailySignups).toEqual([
      { date: "2026-11-14", count: 3 },
      { date: "2026-11-15", count: 5 },
    ]);
    // Only SELECTs were issued.
    expect(calls.every((c) => c.sql.trimStart().toUpperCase().startsWith("SELECT"))).toBe(true);
  });

  it("handles a missing anonymous column gracefully", async () => {
    const calls: { sql: string }[] = [];
    const r = reader(
      [
        { match: "sqlite_master", rows: [{ name: "users" }] },
        { match: "pragma_table_info", rows: [{ name: "id" }, { name: "created_at" }] },
        { match: "GROUP BY day", rows: [] },
        { match: 'COUNT(*) AS n FROM "users"', rows: [{ n: 7 }] },
        { match: "LIMIT 1", rows: [{ v: "2026-11-01T00:00:00.000Z" }] },
      ],
      calls,
    );
    const stats = await r.getUserStats();
    expect(stats.totalUsers).toBe(7);
    expect(stats.anonymousUsers).toBeNull();
  });

  it("throws when there is no user table", async () => {
    const calls: { sql: string }[] = [];
    const r = reader([{ match: "sqlite_master", rows: [] }], calls);
    await expect(r.getUserStats()).rejects.toBeInstanceOf(D1ReadError);
  });

  it("keeps Cloudflare error detail server-side only and never leaks the token (F3)", async () => {
    const failingFetch = async () =>
      ({
        status: 401,
        json: async () => ({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          result: [],
        }),
      }) as Response;
    const r = new RemoteD1Reader({
      accountId: "a",
      databaseId: "d",
      token: "super-secret-token",
      fetchFn: failingFetch as typeof fetch,
    });
    const err = await r.getUserStats().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D1ReadError);
    const readErr = err as D1ReadError;
    // The client-facing message is generic; the CF detail lives in a
    // separate field for server logs and carries the CF code.
    expect(readErr.message).toBe("D1 query failed");
    expect(readErr.message).not.toContain("Authentication error");
    expect(readErr.detail).toContain("Authentication error");
    expect(readErr.code).toBe(10000);
    expect(readErr.detail).not.toContain("super-secret-token");
  });

  it("refuses non-SELECT statements before any network call (F6)", async () => {
    let fetchCalls = 0;
    const countingFetch = async () => {
      fetchCalls++;
      return {
        status: 200,
        json: async () => ({ success: true, errors: [], result: [{ results: [] }] }),
      } as Response;
    };
    const r = new RemoteD1Reader({
      accountId: "a",
      databaseId: "d",
      token: "t",
      fetchFn: countingFetch as typeof fetch,
    });
    await expect(r.query("DELETE FROM user")).rejects.toBeInstanceOf(D1ReadError);
    await expect(r.query("UPDATE user SET name = 'x'")).rejects.toBeInstanceOf(D1ReadError);
    await expect(r.query("INSERT INTO user VALUES (1)")).rejects.toBeInstanceOf(D1ReadError);
    await expect(r.query("DROP TABLE user")).rejects.toBeInstanceOf(D1ReadError);
    await expect(r.query("SELECT 1; SELECT 2")).rejects.toBeInstanceOf(D1ReadError);
    await expect(
      r.query("WITH x AS (SELECT 1) DELETE FROM user WHERE id IN (SELECT * FROM x)"),
    ).rejects.toBeInstanceOf(D1ReadError);
    expect(fetchCalls).toBe(0);
  });

  it("allows SELECT and WITH ... SELECT, tolerating comments and a trailing semicolon (F6)", async () => {
    let fetchCalls = 0;
    const okFetch = async () => {
      fetchCalls++;
      return {
        status: 200,
        json: async () => ({ success: true, errors: [], result: [{ results: [] }] }),
      } as Response;
    };
    const r = new RemoteD1Reader({
      accountId: "a",
      databaseId: "d",
      token: "t",
      fetchFn: okFetch as typeof fetch,
    });
    await r.query("SELECT 1");
    await r.query("  select 2;  ");
    await r.query("-- a comment\nSELECT 3");
    await r.query("/* block */ WITH x AS (SELECT 1) SELECT * FROM x");
    await r.query("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON 1 = 1");
    expect(fetchCalls).toBe(5);
  });

  it("URL-encodes the account and database ids in the query URL (F4)", async () => {
    let seenUrl = "";
    const capturingFetch = async (url: unknown) => {
      seenUrl = String(url);
      return {
        status: 200,
        json: async () => ({ success: true, errors: [], result: [{ results: [] }] }),
      } as Response;
    };
    const r = new RemoteD1Reader({
      accountId: "ac/c?x",
      databaseId: "db#frag",
      token: "t",
      fetchFn: capturingFetch as typeof fetch,
    });
    await r.query("SELECT 1");
    expect(seenUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/ac%2Fc%3Fx/d1/database/db%23frag/query",
    );
  });
});
