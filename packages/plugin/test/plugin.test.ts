import { describe, expect, it } from "vitest";
import { isSha256Hex, sha256Hex, timingSafeEqualHex, verifyBearerKey } from "../src/auth";
import { clampDays, computeStats, type StatsAdapter, type StatsWhere } from "../src/stats";

const KEY = "test-api-key-with-plenty-of-entropy-0123456789";

describe("sha256Hex / isSha256Hex", () => {
  it("produces a 64-char lowercase hex digest", async () => {
    const hash = await sha256Hex(KEY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isSha256Hex(hash)).toBe(true);
    // Known vector: SHA-256 of the empty string.
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("rejects non-hashes", () => {
    expect(isSha256Hex("")).toBe(false);
    expect(isSha256Hex("xyz")).toBe(false);
    expect(isSha256Hex("A".repeat(64))).toBe(false); // uppercase not accepted
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });
});

describe("timingSafeEqualHex", () => {
  it("compares digests", async () => {
    const a = await sha256Hex("a");
    const b = await sha256Hex("b");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, b)).toBe(false);
  });
});

describe("verifyBearerKey", () => {
  it("accepts only the exact key", async () => {
    const hash = await sha256Hex(KEY);
    const headers = (v?: string) => new Headers(v ? { authorization: v } : {});
    expect(await verifyBearerKey(headers(`Bearer ${KEY}`), hash)).toBe(true);
    expect(await verifyBearerKey(headers(`bearer ${KEY}`), hash)).toBe(true);
    expect(await verifyBearerKey(headers("Bearer wrong-key"), hash)).toBe(false);
    expect(await verifyBearerKey(headers(KEY), hash)).toBe(false);
    expect(await verifyBearerKey(headers("Bearer "), hash)).toBe(false);
    expect(await verifyBearerKey(headers(), hash)).toBe(false);
    expect(await verifyBearerKey(undefined, hash)).toBe(false);
  });
});

describe("clampDays", () => {
  it("defaults to 30 and clamps to [1, 90]", () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays("")).toBe(30);
    expect(clampDays("abc")).toBe(30);
    expect(clampDays(7)).toBe(7);
    expect(clampDays("45")).toBe(45);
    expect(clampDays(90)).toBe(90);
    expect(clampDays(365)).toBe(90);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(-5)).toBe(1);
    expect(clampDays(29.9)).toBe(29);
  });
});

interface FakeUser {
  createdAt: Date;
  isAnonymous?: boolean;
}

function fakeAdapter(users: FakeUser[]): StatsAdapter {
  const matches = (u: FakeUser, where: StatsWhere[] = []) =>
    where.every((w) => {
      const value = (u as unknown as Record<string, unknown>)[w.field];
      if (w.operator === "gte") return (value as Date) >= (w.value as Date);
      return value === w.value;
    });
  return {
    async count({ where }) {
      return users.filter((u) => matches(u, where)).length;
    },
    async findMany({ where, limit, select }) {
      const rows = users
        .filter((u) => matches(u, where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit ?? Number.POSITIVE_INFINITY);
      return rows.map((u) => {
        const row: Record<string, unknown> = { ...u };
        if (select) {
          for (const key of Object.keys(row)) if (!select.includes(key)) delete row[key];
        }
        return row;
      });
    },
  };
}

const NOW = new Date("2026-11-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("computeStats", () => {
  it("counts totals, anonymous split and daily buckets", async () => {
    const users: FakeUser[] = [
      { createdAt: daysAgo(0), isAnonymous: false },
      { createdAt: daysAgo(0), isAnonymous: true },
      { createdAt: daysAgo(1), isAnonymous: false },
      { createdAt: daysAgo(40), isAnonymous: false }, // outside a 30d window
    ];
    const stats = await computeStats(fakeAdapter(users), {
      days: 30,
      hasAnonymousField: true,
      now: NOW,
    });
    expect(stats.version).toBe(1);
    expect(stats.totalUsers).toBe(4);
    expect(stats.anonymousUsers).toBe(1);
    expect(stats.dailySignups).toEqual([
      { date: "2026-11-14", count: 1 },
      { date: "2026-11-15", count: 2 },
    ]);
    expect(stats.asOf).toBe(NOW.toISOString());
  });

  it("returns anonymousUsers null when the field is not detectable", async () => {
    const stats = await computeStats(fakeAdapter([{ createdAt: daysAgo(0) }]), {
      days: 30,
      hasAnonymousField: false,
      now: NOW,
    });
    expect(stats.anonymousUsers).toBeNull();
    expect(stats.totalUsers).toBe(1);
  });

  it("returns empty daily signups for an empty window", async () => {
    const stats = await computeStats(fakeAdapter([{ createdAt: daysAgo(60) }]), {
      days: 30,
      hasAnonymousField: false,
      now: NOW,
    });
    expect(stats.dailySignups).toEqual([]);
    expect(stats.totalUsers).toBe(1);
  });
});
