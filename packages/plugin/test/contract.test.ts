import { afterEach, describe, expect, it, vi } from "vitest";
import { authfleet } from "../src/index";
import { createFixture, FIXTURE_KEY, type FixtureUser } from "./fixture";

/**
 * Contract tests for the plugin, run against a real Better Auth app on
 * SQLite (non-D1). The response shapes asserted here ARE contract v1 —
 * see openspec/changes/add-agent-plugin/specs/agent-plugin/spec.md.
 */

const NOW = new Date();
const daysAgo = (n: number, hours = 0) =>
  new Date(NOW.getTime() - n * 86_400_000 - hours * 3_600_000);
const dayString = (d: Date) => d.toISOString().slice(0, 10);

const SEED: FixtureUser[] = [
  {
    name: "Alice Pii",
    email: "alice.pii@example.com",
    createdAt: daysAgo(0, 1),
    isAnonymous: false,
  },
  {
    name: "Guest One",
    email: "guest1.pii@example.com",
    createdAt: daysAgo(0, 2),
    isAnonymous: true,
  },
  { name: "Bob Pii", email: "bob.pii@example.com", createdAt: daysAgo(1), isAnonymous: false },
  { name: "Guest Two", email: "guest2.pii@example.com", createdAt: daysAgo(1), isAnonymous: true },
  { name: "Carol Old", email: "carol.pii@example.com", createdAt: daysAgo(45), isAnonymous: false },
];

describe("contract v1 — validate", () => {
  it("returns exactly { ok: true, version: 1 }", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    const res = await fixture.call("/authfleet/validate", FIXTURE_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 1 });
  });
});

describe("contract v1 — auth", () => {
  it("missing key → 401, wrong key → 401, correct key → 200, on both endpoints", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    for (const path of ["/authfleet/validate", "/authfleet/stats"]) {
      expect((await fixture.call(path)).status).toBe(401);
      expect((await fixture.call(path, "wrong-key-wrong-key-wrong-key")).status).toBe(401);
      expect((await fixture.call(path, FIXTURE_KEY)).status).toBe(200);
    }
  });

  it("401 bodies do not reveal which check failed", async () => {
    const fixture = await createFixture({ users: [] });
    const missing = await fixture.call("/authfleet/stats");
    const wrong = await fixture.call("/authfleet/stats", "nope-nope-nope");
    expect(JSON.stringify(missing.body)).toBe(JSON.stringify(wrong.body));
    expect(missing.rawText).not.toMatch(/hash|missing|malformed/i);
  });

  it("the API key never appears in app logs during requests", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    try {
      await fixture.call("/authfleet/stats", FIXTURE_KEY);
      await fixture.call("/authfleet/stats", "wrong-key-wrong-key-wrong-key");
      await fixture.call("/authfleet/validate", FIXTURE_KEY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join("\n")).not.toContain(FIXTURE_KEY);
  });
});

describe("contract v1 — stats", () => {
  it("returns the exact contract shape with correct counts and buckets", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    const res = await fixture.call("/authfleet/stats?days=30", FIXTURE_KEY);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["anonymousUsers", "asOf", "dailySignups", "totalUsers", "version"].sort(),
    );
    expect(body.version).toBe(1);
    expect(body.totalUsers).toBe(5);
    expect(body.anonymousUsers).toBe(2);
    expect(typeof body.asOf).toBe("string");
    const buckets = new Map(
      (body.dailySignups as { date: string; count: number }[]).map((d) => [d.date, d.count]),
    );
    expect(buckets.get(dayString(daysAgo(0)))).toBe(2);
    expect(buckets.get(dayString(daysAgo(1)))).toBe(2);
    // The 45-day-old signup is outside the 30-day window.
    expect([...buckets.values()].reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("defaults days to 30 and clamps to 90", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    const sum = async (path: string) => {
      const res = await fixture.call(path, FIXTURE_KEY);
      const body = res.body as { dailySignups: { count: number }[] };
      return body.dailySignups.reduce((a, d) => a + d.count, 0);
    };
    expect(await sum("/authfleet/stats")).toBe(4); // 30d default
    expect(await sum("/authfleet/stats?days=90")).toBe(5); // includes the 45d signup
    expect(await sum("/authfleet/stats?days=365")).toBe(5); // clamped to 90
    expect(await sum("/authfleet/stats?days=1")).toBe(2); // today only
  });

  it("anonymousUsers is null — never zero — without the anonymous plugin", async () => {
    const users = SEED.map(({ isAnonymous: _drop, ...rest }) => rest);
    const fixture = await createFixture({ withAnonymous: false, users });
    const res = await fixture.call("/authfleet/stats", FIXTURE_KEY);
    expect(res.status).toBe(200);
    const body = res.body as { totalUsers: number; anonymousUsers: unknown };
    expect(body.totalUsers).toBe(5);
    expect(body.anonymousUsers).toBeNull();
  });

  it("counts a real sign-up made through the app's normal flow", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: [] });
    await fixture.auth.api.signUpEmail({
      body: { email: "new.user@example.com", password: "password-12345", name: "New User" },
    });
    const res = await fixture.call("/authfleet/stats?days=1", FIXTURE_KEY);
    const body = res.body as { totalUsers: number; dailySignups: { count: number }[] };
    expect(body.totalUsers).toBe(1);
    expect(body.dailySignups.reduce((a, d) => a + d.count, 0)).toBe(1);
  });
});

describe("contract v1 — PII absence", () => {
  it("stats and validate responses contain no emails, names or user ids", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    for (const path of ["/authfleet/validate", "/authfleet/stats?days=90"]) {
      const res = await fixture.call(path, FIXTURE_KEY);
      expect(res.status).toBe(200);
      for (const user of SEED) {
        expect(res.rawText).not.toContain(user.email);
        expect(res.rawText).not.toContain(user.name);
      }
      for (const id of fixture.seededIds) {
        expect(res.rawText).not.toContain(id);
      }
    }
  });
});

describe("contract v1 — read-only against the host database", () => {
  it("stats calls create no tables and change no row counts", async () => {
    const fixture = await createFixture({ withAnonymous: true, users: SEED });
    const tablesBefore = fixture.tableNames();
    const rowsBefore = fixture.userRowCount();
    for (let i = 0; i < 3; i++) {
      await fixture.call("/authfleet/stats?days=90", FIXTURE_KEY);
      await fixture.call("/authfleet/validate", FIXTURE_KEY);
    }
    expect(fixture.tableNames()).toEqual(tablesBefore);
    expect(fixture.tableNames().join(" ")).not.toMatch(/authfleet/i);
    expect(fixture.userRowCount()).toBe(rowsBefore);
  });
});

describe("contract v1 — schema customisation and basePath", () => {
  it("renamed user model and created-at column still produce correct stats", async () => {
    const fixture = await createFixture({
      withAnonymous: true,
      customSchema: true,
      users: SEED,
    });
    expect(fixture.tableNames()).toContain("app_user");
    const res = await fixture.call("/authfleet/stats?days=30", FIXTURE_KEY);
    expect(res.status).toBe(200);
    const body = res.body as {
      totalUsers: number;
      anonymousUsers: number;
      dailySignups: { count: number }[];
    };
    expect(body.totalUsers).toBe(5);
    expect(body.anonymousUsers).toBe(2);
    expect(body.dailySignups.reduce((a, d) => a + d.count, 0)).toBe(4);
  });

  it("endpoints compose under a custom Better Auth basePath", async () => {
    const fixture = await createFixture({
      withAnonymous: true,
      customBasePath: true,
      users: SEED,
    });
    const res = await fixture.call("/authfleet/validate", FIXTURE_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 1 });
  });
});

describe("factory misconfiguration", () => {
  const savedEnv = process.env.AUTHFLEET_API_KEY_HASH;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AUTHFLEET_API_KEY_HASH;
    else process.env.AUTHFLEET_API_KEY_HASH = savedEnv;
  });

  it("throws at startup when no hash is configured anywhere", () => {
    delete process.env.AUTHFLEET_API_KEY_HASH;
    expect(() => authfleet()).toThrow(/AUTHFLEET_API_KEY_HASH/);
    expect(() => authfleet({})).toThrow(/AUTHFLEET_API_KEY_HASH/);
    expect(() => authfleet({ apiKeyHash: "" })).toThrow(/AUTHFLEET_API_KEY_HASH/);
  });

  it("throws at startup for a malformed hash", () => {
    delete process.env.AUTHFLEET_API_KEY_HASH;
    expect(() => authfleet({ apiKeyHash: "not-a-hash" })).toThrow(/SHA-256/);
  });

  it("falls back to the AUTHFLEET_API_KEY_HASH env variable", async () => {
    const { sha256Hex } = await import("../src/index");
    process.env.AUTHFLEET_API_KEY_HASH = await sha256Hex("env-key");
    expect(() => authfleet()).not.toThrow();
  });
});
