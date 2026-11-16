import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { authfleet, sha256Hex } from "authfleet";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { anonymous } from "better-auth/plugins";
import { Hono } from "hono";

/**
 * E2E fixture: a REAL host app, wired the way a real user wires it —
 * a Hono app mounting Better Auth's handler on `/api/auth/*`, served
 * over a real TCP socket by @hono/node-server. Nothing in the request
 * path is in-process: the plugin endpoints and the dashboard-side
 * HttpAgentReader are exercised through actual HTTP, which is the one
 * layer the unit and contract suites (in-process `auth.handler`
 * calls) cannot see.
 *
 * The auth instance needs its final baseURL (with the OS-assigned
 * port) at construction time, while the port only exists once the
 * server is listening — so the Hono handler delegates to a mutable
 * reference that is filled in before any test runs.
 */

/** Same getAuthTables-DDL approach as packages/plugin/test/fixture.ts. */
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

const DAY_MS = 86_400_000;

export interface SeedUser {
  name: string;
  email: string;
  daysAgo: number;
  isAnonymous?: boolean;
}

/**
 * Five seeded users: today 1 normal + 1 anonymous, yesterday 1 normal
 * + 1 anonymous, 45 days ago 1 normal. Names/emails are deliberately
 * PII-flavoured so the absence assertions have something to catch.
 */
export const SEED_USERS: SeedUser[] = [
  { name: "Alice Pii", email: "alice.pii@example.com", daysAgo: 0 },
  { name: "Guest Pii", email: "guest.pii@example.com", daysAgo: 0, isAnonymous: true },
  { name: "Bob Pii", email: "bob.pii@example.com", daysAgo: 1 },
  { name: "Yara Pii", email: "yara.pii@example.com", daysAgo: 1, isAnonymous: true },
  { name: "Carol Pii", email: "carol.pii@example.com", daysAgo: 45 },
];

export interface SeededUser extends SeedUser {
  id: string;
}

export interface TestApp {
  /** The app's origin, e.g. http://127.0.0.1:43210 */
  origin: string;
  /** The Better Auth base URL: origin + /api/auth (the reader's baseUrl). */
  baseUrl: string;
  /** The raw plugin API key (only its SHA-256 hash reaches the plugin). */
  apiKey: string;
  seeded: SeededUser[];
  close: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  // A fresh random key per run; the plugin only ever sees its hash.
  const apiKey = `e2e-${randomBytes(32).toString("hex")}`;
  const apiKeyHash = await sha256Hex(apiKey);
  const db = new DatabaseSync(":memory:");

  let handler: ((request: Request) => Promise<Response>) | undefined;
  const app = new Hono();
  // The canonical mounting from the Better Auth docs, verbatim shape.
  app.on(["POST", "GET"], "/api/auth/*", (c) => {
    if (!handler) return c.text("auth not ready", 503);
    return handler(c.req.raw);
  });

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const auth = betterAuth({
    appName: "authfleet-test-e2e",
    baseURL: origin,
    secret: "e2e-fixture-secret-e2e-fixture-secret-0123456789",
    database: db,
    emailAndPassword: { enabled: true },
    plugins: [anonymous(), authfleet({ apiKeyHash })],
  });
  handler = auth.handler;

  createSchema(db, auth.options);

  const ctx = await auth.$context;
  const seeded: SeededUser[] = [];
  for (const user of SEED_USERS) {
    const createdAt = new Date(Date.now() - user.daysAgo * DAY_MS);
    const created = await ctx.adapter.create({
      model: "user",
      data: {
        name: user.name,
        email: user.email,
        emailVerified: false,
        createdAt,
        updatedAt: createdAt,
        ...(user.isAnonymous !== undefined ? { isAnonymous: user.isAnonymous } : {}),
      },
    });
    seeded.push({ ...user, id: (created as { id: string }).id });
  }

  return {
    origin,
    baseUrl: `${origin}/api/auth`,
    apiKey,
    seeded,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch() keep-alive sockets would otherwise hold close() open.
        // (serve() is typed as an HTTP/1.1 | HTTP/2 union; this fixture
        // serves plain HTTP/1.1, where closeAllConnections exists.)
        (server as Server).closeAllConnections();
      });
      db.close();
    },
  };
}
