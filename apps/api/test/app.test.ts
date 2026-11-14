import { InMemoryProjectRepository, importEncryptionKey } from "@authfleet/core";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app";

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const OPERATOR = { "x-authfleet-operator": "op@example.com", "content-type": "application/json" };

function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    repo: new InMemoryProjectRepository(),
    getEncryptionKey: () => importEncryptionKey(KEY_B64),
    demoEnabled: true,
    readerFactory: () => ({
      getUserStats: async () => ({
        totalUsers: 321,
        anonymousUsers: 12,
        dailySignups: [{ date: "2026-11-15", count: 4 }],
        asOf: new Date().toISOString(),
      }),
    }),
    ...overrides,
  };
}

describe("operator gate", () => {
  it("rejects /api calls without an operator identity", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/api/projects");
    expect(res.status).toBe(401);
  });

  it("allows health without an operator", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("dev bypass supplies a local operator", async () => {
    const app = createApp(testDeps({ devBypass: true, devOperator: "dev@local" }));
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operator: string };
    expect(body.operator).toBe("dev@local");
  });
});

describe("projects CRUD", () => {
  it("creates a project; the token is stored encrypted and never returned", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify({
        name: "Acme",
        cfAccountId: "acct-1",
        d1DatabaseId: "db-1",
        token: "cf-token-abcdef9999",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { id: string; tokenHint: string; name: string };
    };
    expect(body.project.tokenHint).toBe("9999");
    expect(JSON.stringify(body)).not.toContain("cf-token-abcdef9999");

    const stored = await deps.repo.listProjects();
    expect(stored[0]?.tokenCiphertext).not.toContain("cf-token");
    expect(stored[0]?.id).toMatch(/^[0-9a-z]{26}$/);
  });

  it("rejects invalid payloads", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("includes the demo project when demo mode is on", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/api/projects", { headers: OPERATOR });
    const body = (await res.json()) as { projects: { id: string; isDemo: boolean }[] };
    expect(body.projects[0]?.id).toBe("demo");
    expect(body.projects[0]?.isDemo).toBe(true);
  });

  it("deletes a project", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify({
        name: "X",
        cfAccountId: "a",
        d1DatabaseId: "d",
        token: "12345678tok",
      }),
    });
    const { project } = (await created.json()) as { project: { id: string } };
    const res = await app.request(`/api/projects/${project.id}`, {
      method: "DELETE",
      headers: OPERATOR,
    });
    expect(res.status).toBe(200);
    expect(await deps.repo.listProjects()).toHaveLength(0);
  });
});

describe("stats", () => {
  it("serves demo stats without a reader", async () => {
    const app = createApp(
      testDeps({
        readerFactory: () => {
          throw new Error("reader must not be used for demo");
        },
      }),
    );
    const res = await app.request("/api/projects/demo/stats", { headers: OPERATOR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { stats: { totalUsers: number } } };
    expect(body.summary.stats.totalUsers).toBeGreaterThan(1000);
  });

  it("serves stats for a real project via the injected reader", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify({
        name: "Y",
        cfAccountId: "a",
        d1DatabaseId: "d",
        token: "12345678tok",
      }),
    });
    const { project } = (await created.json()) as { project: { id: string } };
    const res = await app.request(`/api/projects/${project.id}/stats`, { headers: OPERATOR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { stats: { totalUsers: number; anonymousUsers: number }; newLast7Days: number };
    };
    expect(body.summary.stats.totalUsers).toBe(321);
    expect(body.summary.stats.anonymousUsers).toBe(12);
  });

  it("404s for unknown projects", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/api/projects/nope/stats", { headers: OPERATOR });
    expect(res.status).toBe(404);
  });

  it("manual snapshot records today's total", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify({
        name: "Z",
        cfAccountId: "a",
        d1DatabaseId: "d",
        token: "12345678tok",
      }),
    });
    const { project } = (await created.json()) as { project: { id: string } };
    const res = await app.request(`/api/projects/${project.id}/snapshot`, {
      method: "POST",
      headers: OPERATOR,
    });
    expect(res.status).toBe(200);
    const snaps = await deps.repo.listSnapshots(project.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.totalUsers).toBe(321);
  });
});
