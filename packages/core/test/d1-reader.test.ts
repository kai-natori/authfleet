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

  it("surfaces Cloudflare API errors without leaking the token", async () => {
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
    await expect(r.getUserStats()).rejects.toThrow(/Authentication error/);
    await expect(r.getUserStats()).rejects.not.toThrow(/super-secret-token/);
  });
});
