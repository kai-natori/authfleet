import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { authfleet, sha256Hex } from "authfleet";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { anonymous } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

/**
 * Version-matrix cell: Better Auth 1.4.22 (the support floor).
 *
 * The same contract assertions as packages/plugin/test/contract.test.ts
 * (which runs against 1.7.x), kept self-contained so pnpm resolves the
 * plugin's `better-auth` peer to THIS package's 1.4.22 — the first test
 * proves that wiring, otherwise the matrix would be theatre.
 */

const FIXTURE_KEY = "fixture-api-key-0123456789abcdef-entropy";
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function createSchema(db: DatabaseSync, options: BetterAuthOptions): void {
  const tables = getAuthTables(options) as Record<
    string,
    {
      modelName: string;
      fields: Record<
        string,
        { type: string; required?: boolean; unique?: boolean; fieldName?: string; bigint?: boolean }
      >;
    }
  >;
  const typeMap = (type: string, bigint?: boolean): string => {
    switch (type) {
      case "string":
        return "text";
      case "boolean":
        return "integer";
      case "number":
        return bigint ? "bigint" : "integer";
      case "date":
        return "date";
      default:
        return "text";
    }
  };
  for (const table of Object.values(tables)) {
    const columns = ['"id" text not null primary key'];
    for (const [logical, field] of Object.entries(table.fields)) {
      if (logical === "id") continue;
      const column = field.fieldName || logical;
      columns.push(
        `"${column}" ${typeMap(field.type, field.bigint)}${field.required ? " not null" : ""}${field.unique ? " unique" : ""}`,
      );
    }
    db.exec(`CREATE TABLE "${table.modelName}" (${columns.join(", ")})`);
  }
}

async function createFixture() {
  const apiKeyHash = await sha256Hex(FIXTURE_KEY);
  const db = new DatabaseSync(":memory:");
  const auth = betterAuth({
    appName: "authfleet-fixture-ba14",
    baseURL: "http://localhost",
    secret: "fixture-secret-fixture-secret-0123456789",
    database: db,
    emailAndPassword: { enabled: true },
    plugins: [
      anonymous(),
      // The cast is a monorepo-link artefact: the plugin's dist types
      // resolve `better-auth` from the plugin's own devDependency
      // (1.7), while a published install resolves them against the
      // consumer's own better-auth instance. Runtime binding to 1.4 is
      // enforced by vitest.config.ts aliases.
      authfleet({ apiKeyHash }) as unknown as BetterAuthPlugin,
    ],
  });
  createSchema(db, auth.options);
  const ctx = await auth.$context;
  const seed = [
    {
      email: "alice.pii@example.com",
      name: "Alice Pii",
      createdAt: daysAgo(0),
      isAnonymous: false,
    },
    { email: "guest.pii@example.com", name: "Guest Pii", createdAt: daysAgo(0), isAnonymous: true },
    { email: "bob.pii@example.com", name: "Bob Pii", createdAt: daysAgo(1), isAnonymous: false },
    {
      email: "carol.pii@example.com",
      name: "Carol Pii",
      createdAt: daysAgo(45),
      isAnonymous: false,
    },
  ];
  const ids: string[] = [];
  for (const user of seed) {
    const created = await ctx.adapter.create({
      model: "user",
      data: { ...user, emailVerified: false, updatedAt: user.createdAt },
    });
    ids.push((created as { id: string }).id);
  }
  const call = async (path: string, key?: string) => {
    const headers = new Headers();
    if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
    const res = await auth.handler(new Request(`http://localhost/api/auth${path}`, { headers }));
    const rawText = await res.text();
    return { status: res.status, body: JSON.parse(rawText) as unknown, rawText };
  };
  return { call, ids, seed };
}

describe("matrix wiring", () => {
  it("this package's better-auth is 1.4.x (the version the aliases bind)", () => {
    // better-auth 1.4's exports map does not expose ./package.json, so
    // read it from disk next to this package's installed copy.
    const pkgPath = new URL("../node_modules/better-auth/package.json", import.meta.url);
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(version).toMatch(/^1\.4\./);
    // The vitest.config.ts aliases bind every better-auth import in
    // the module graph (plugin source included) to that copy.
  });
});

describe("contract v1 on Better Auth 1.4", () => {
  it("validate returns exactly { ok: true, version: 1 }", async () => {
    const fixture = await createFixture();
    const res = await fixture.call("/authfleet/validate", FIXTURE_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 1 });
  });

  it("missing/wrong key → 401, correct key → 200", async () => {
    const fixture = await createFixture();
    expect((await fixture.call("/authfleet/stats")).status).toBe(401);
    expect((await fixture.call("/authfleet/stats", "wrong-key-wrong-key")).status).toBe(401);
    expect((await fixture.call("/authfleet/stats", FIXTURE_KEY)).status).toBe(200);
  });

  it("stats shape, counts, anonymous split and buckets match the contract", async () => {
    const fixture = await createFixture();
    const res = await fixture.call("/authfleet/stats?days=30", FIXTURE_KEY);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["anonymousUsers", "asOf", "dailySignups", "totalUsers", "version"].sort(),
    );
    expect(body.version).toBe(1);
    expect(body.totalUsers).toBe(4);
    expect(body.anonymousUsers).toBe(1);
    const total = (body.dailySignups as { count: number }[]).reduce((a, d) => a + d.count, 0);
    expect(total).toBe(3); // 45-day-old signup outside the 30d window
  });

  it("responses contain no PII (emails, names, ids)", async () => {
    const fixture = await createFixture();
    const res = await fixture.call("/authfleet/stats?days=90", FIXTURE_KEY);
    for (const user of fixture.seed) {
      expect(res.rawText).not.toContain(user.email);
      expect(res.rawText).not.toContain(user.name);
    }
    for (const id of fixture.ids) expect(res.rawText).not.toContain(id);
  });
});
