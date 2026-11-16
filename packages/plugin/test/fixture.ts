import { DatabaseSync } from "node:sqlite";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { anonymous } from "better-auth/plugins";
import { authfleet, sha256Hex } from "../src/index";

/**
 * Create the fixture schema from Better Auth's own resolved schema
 * (`getAuthTables` — core tables + additionalFields + plugin fields,
 * with physical model/field names). `getMigrations` is not exported
 * from `better-auth/db` on 1.7, so the fixture renders the same DDL
 * the migration generator would: sqlite type map string→text,
 * boolean→integer, number→integer, date→date, json→text (verified
 * against real migration output on 1.7.25; dates are stored as ISO
 * strings and read back as Date objects by the adapter).
 */
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

/**
 * Fixture Better Auth app on a NON-D1 database: SQLite via node:sqlite
 * (Better Auth's Kysely adapter), in memory. This is the DB-agnosticism
 * proof — nothing Cloudflare anywhere near it.
 */

export const FIXTURE_KEY = "fixture-api-key-0123456789abcdef-entropy";

export interface FixtureUser {
  name: string;
  email: string;
  createdAt: Date;
  isAnonymous?: boolean;
}

export interface Fixture {
  auth: ReturnType<typeof betterAuth>;
  db: DatabaseSync;
  apiKeyHash: string;
  /** User ids created by seeding, for the PII-absence assertions. */
  seededIds: string[];
  call: (path: string, key?: string) => Promise<{ status: number; body: unknown; rawText: string }>;
  tableNames: () => string[];
  userRowCount: () => number;
}

export interface FixtureOptions {
  withAnonymous?: boolean;
  customSchema?: boolean;
  customBasePath?: boolean;
  users?: FixtureUser[];
}

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const apiKeyHash = await sha256Hex(FIXTURE_KEY);
  const db = new DatabaseSync(":memory:");
  const auth = betterAuth({
    appName: "authfleet-fixture",
    baseURL: "http://localhost",
    secret: "fixture-secret-fixture-secret-0123456789",
    database: db,
    ...(options.customBasePath ? { basePath: "/custom-auth" } : {}),
    emailAndPassword: { enabled: true },
    ...(options.customSchema
      ? { user: { modelName: "app_user", fields: { createdAt: "created_at_ts" } } }
      : {}),
    plugins: [...(options.withAnonymous ? [anonymous()] : []), authfleet({ apiKeyHash })],
  });

  createSchema(db, auth.options);

  const ctx = await auth.$context;
  const seededIds: string[] = [];
  for (const user of options.users ?? []) {
    const created = await ctx.adapter.create({
      model: "user",
      data: {
        name: user.name,
        email: user.email,
        emailVerified: false,
        createdAt: user.createdAt,
        updatedAt: user.createdAt,
        ...(user.isAnonymous !== undefined ? { isAnonymous: user.isAnonymous } : {}),
      },
    });
    seededIds.push((created as { id: string }).id);
  }

  const basePath = options.customBasePath ? "/custom-auth" : "/api/auth";
  return {
    auth,
    db,
    apiKeyHash,
    seededIds,
    async call(path, key) {
      const headers = new Headers();
      if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
      const res = await auth.handler(
        new Request(`http://localhost${basePath}${path}`, { headers }),
      );
      const rawText = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(rawText);
      } catch {
        body = null;
      }
      return { status: res.status, body, rawText };
    },
    tableNames() {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      return rows.map((r) => r.name);
    },
    userRowCount() {
      const table = options.customSchema ? "app_user" : "user";
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
      return Number(row.n);
    },
  };
}
