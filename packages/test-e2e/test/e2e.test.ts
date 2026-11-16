import { AgentReadError, HttpAgentReader } from "@authfleet/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./fixture";

/**
 * True end-to-end coverage of the agent-plugin path:
 *
 *   Hono host app → real HTTP → Better Auth + authfleet plugin
 *   HttpAgentReader (the dashboard's actual consumer) → same HTTP
 *
 * The unit suite mocks the adapter and the contract suite calls
 * `auth.handler` in-process; only this suite proves the composed
 * system — Hono mounting, real sockets, the plugin endpoints and the
 * reader's parsing — works together the way a user's deployment does.
 */

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
});

interface RawResponse {
  status: number;
  body: unknown;
  rawText: string;
}

async function getRaw(path: string, key?: string): Promise<RawResponse> {
  const headers = new Headers();
  if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
  const res = await fetch(`${app.baseUrl}${path}`, { headers });
  const rawText = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = null;
  }
  return { status: res.status, body, rawText };
}

interface StatsBody {
  version: number;
  totalUsers: number;
  anonymousUsers: number | null;
  dailySignups: { date: string; count: number }[];
  asOf: string;
}

const utcDate = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const bucket = (stats: StatsBody, daysAgo: number) =>
  stats.dailySignups.find((d) => d.date === utcDate(daysAgo))?.count;

describe("plugin endpoints over real HTTP", () => {
  it("validate without an Authorization header → 401", async () => {
    const res = await getRaw("/authfleet/validate");
    expect(res.status).toBe(401);
  });

  it("validate with a wrong Bearer key → 401", async () => {
    const res = await getRaw("/authfleet/validate", "wrong-key-wrong-key-wrong-key");
    expect(res.status).toBe(401);
  });

  it("validate with the correct key → 200 and exactly { ok: true, version: 1 }", async () => {
    const res = await getRaw("/authfleet/validate", app.apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 1 });
  });

  it("stats reports the five seeded users with the contract shape and buckets", async () => {
    const res = await getRaw("/authfleet/stats?days=30", app.apiKey);
    expect(res.status).toBe(200);
    const body = res.body as StatsBody;
    expect(Object.keys(body).sort()).toEqual(
      ["anonymousUsers", "asOf", "dailySignups", "totalUsers", "version"].sort(),
    );
    expect(body.version).toBe(1);
    expect(body.totalUsers).toBe(5);
    expect(body.anonymousUsers).toBe(2);
    // Daily buckets cover the 30-day window only: today 2, yesterday
    // 2, and the 45-day-old user contributes no bucket.
    expect(bucket(body, 0)).toBe(2);
    expect(bucket(body, 1)).toBe(2);
    expect(body.dailySignups).toHaveLength(2);
    expect(body.dailySignups.reduce((a, d) => a + d.count, 0)).toBe(4);
  });

  it("stats responses contain no PII (emails, names, ids) and no key material", async () => {
    const res = await getRaw("/authfleet/stats?days=90", app.apiKey);
    expect(res.status).toBe(200);
    for (const user of app.seeded) {
      expect(res.rawText).not.toContain(user.email);
      expect(res.rawText).not.toContain(user.name);
      expect(res.rawText).not.toContain(user.id);
    }
    expect(res.rawText).not.toContain(app.apiKey);
  });
});

describe("dashboard path: HttpAgentReader against the live app", () => {
  it("validate() returns contract version 1", async () => {
    const reader = new HttpAgentReader({ baseUrl: app.baseUrl, apiKey: app.apiKey });
    await expect(reader.validate()).resolves.toEqual({ version: 1 });
  });

  it("getUserStats() returns the same totals as the raw fetch", async () => {
    const raw = await getRaw("/authfleet/stats?days=30", app.apiKey);
    const rawBody = raw.body as StatsBody;
    const reader = new HttpAgentReader({ baseUrl: app.baseUrl, apiKey: app.apiKey });
    const stats = await reader.getUserStats(30);
    expect(stats.totalUsers).toBe(rawBody.totalUsers);
    expect(stats.anonymousUsers).toBe(rawBody.anonymousUsers);
    expect(stats.dailySignups).toEqual(rawBody.dailySignups);
  });

  it("a reader with a wrong key rejects with the unauthorized error kind", async () => {
    const reader = new HttpAgentReader({
      baseUrl: app.baseUrl,
      apiKey: "wrong-key-wrong-key-wrong-key",
    });
    const error = await reader.validate().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentReadError);
    expect((error as AgentReadError).kind).toBe("unauthorized");
  });
});

describe("host app behaviour over real HTTP", () => {
  it("email sign-up works through the Hono mount and the new user is counted", async () => {
    const res = await fetch(`${app.baseUrl}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.origin },
      body: JSON.stringify({
        name: "New Signup",
        email: "signup.pii@example.com",
        password: "<REDACTED_SECRET>",
      }),
    });
    expect([200, 201]).toContain(res.status);

    const stats = (await getRaw("/authfleet/stats?days=30", app.apiKey)).body as StatsBody;
    expect(stats.totalUsers).toBe(6);
    expect(bucket(stats, 0)).toBe(3); // two seeds + the HTTP sign-up
    expect(JSON.stringify(stats)).not.toContain("signup.pii@example.com");
  });
});
