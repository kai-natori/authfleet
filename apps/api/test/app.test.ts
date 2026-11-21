import { InMemoryProjectRepository, importEncryptionKey } from "@authfleet/core";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app";

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const OPERATOR = { "x-authfleet-operator": "op@example.com", "content-type": "application/json" };
/** Format-valid fixtures (audit F4 validation): 32-hex account, UUID database. */
const CF_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const D1_DATABASE_ID = "123e4567-e89b-42d3-a456-426614174000";

function projectPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme",
    cfAccountId: CF_ACCOUNT_ID,
    d1DatabaseId: D1_DATABASE_ID,
    token: "cf-token-abcdef9999",
    ...overrides,
  };
}

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
  });

  it("rejects non-email-shaped operator values (F2)", async () => {
    const app = createApp(testDeps());
    for (const bad of ["x", "not-an-email", "a b@c"]) {
      const res = await app.request("/api/projects", {
        headers: { "x-authfleet-operator": bad },
      });
      expect(res.status).toBe(401);
    }
  });

  it("enforces the operator allowlist when configured (F2)", async () => {
    const app = createApp(testDeps({ operatorEmails: ["Owner@Example.com"] }));
    const allowed = await app.request("/api/projects", {
      headers: { "x-authfleet-operator": "owner@example.com" },
    });
    expect(allowed.status).toBe(200);
    const denied = await app.request("/api/projects", { headers: OPERATOR });
    expect(denied.status).toBe(403);
  });

  it("does not echo the operator identity in responses (F8)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/api/projects", { headers: OPERATOR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("operator");
    expect(JSON.stringify(body)).not.toContain("op@example.com");
  });
});

describe("projects CRUD", () => {
  it("accepts empty and partial D1 updates, preserving omitted fields", async () => {
    const app = createApp(testDeps());
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(projectPayload()),
    });
    const { project } = await created.json();
    for (const patch of [{}, { name: " Renamed " }, { cfAccountId: CF_ACCOUNT_ID }]) {
      const response = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: OPERATOR,
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(200);
      const { project: updated } = await response.json();
      expect(updated.d1DatabaseId).toBe(D1_DATABASE_ID);
      expect(updated.tokenHint).toBe(project.tokenHint);
    }
    for (const patch of [
      { name: "" },
      { cfAccountId: "bad" },
      { d1DatabaseId: "bad" },
      { token: "short" },
    ]) {
      const response = await app.request(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: OPERATOR,
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid project payload" });
    }
  });
  it("creates a project; the token is stored encrypted and never returned", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(projectPayload()),
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

  it("rejects malformed Cloudflare account / database ids (F4)", async () => {
    const app = createApp(testDeps());
    for (const bad of [
      projectPayload({ cfAccountId: "acct-1" }),
      projectPayload({ cfAccountId: "0123456789abcdef0123456789abcdeg" }),
      projectPayload({ cfAccountId: "../../admin" }),
      projectPayload({ d1DatabaseId: "db-1" }),
      projectPayload({ d1DatabaseId: "123e4567e89b42d3a456426614174000" }),
    ]) {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: OPERATOR,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
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
      body: JSON.stringify(projectPayload({ name: "X", token: "12345678tok" })),
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
      body: JSON.stringify(projectPayload({ name: "Y", token: "12345678tok" })),
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

  it("returns a generic error when the upstream reader fails (F3)", async () => {
    const deps = testDeps();
    const app = createApp(
      testDeps({
        repo: deps.repo,
        readerFactory: () => ({
          getUserStats: async () => {
            throw new Error("D1 query failed (7404): no such table: user in account 99887766");
          },
        }),
      }),
    );
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(projectPayload({ name: "Err" })),
    });
    const { project } = (await created.json()) as { project: { id: string } };

    const statsRes = await app.request(`/api/projects/${project.id}/stats`, { headers: OPERATOR });
    expect(statsRes.status).toBe(502);
    const statsBody = (await statsRes.json()) as { error: string };
    expect(statsBody.error).toBe("failed to read project stats");
    expect(JSON.stringify(statsBody)).not.toContain("7404");
    expect(JSON.stringify(statsBody)).not.toContain("99887766");

    const snapRes = await app.request(`/api/projects/${project.id}/snapshot`, {
      method: "POST",
      headers: OPERATOR,
    });
    expect(snapRes.status).toBe(502);
    const snapBody = (await snapRes.json()) as { error: string };
    expect(snapBody.error).toBe("failed to snapshot project");
  });

  it("a token ciphertext transplanted into another project row does not decrypt (F5)", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const create = async (name: string) => {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: OPERATOR,
        body: JSON.stringify(projectPayload({ name })),
      });
      return ((await res.json()) as { project: { id: string } }).project;
    };
    const a = await create("A");
    const b = await create("B");
    const storedA = await deps.repo.getProject(a.id);
    expect(storedA).not.toBeNull();
    // Simulate a registry-write attacker copying A's ciphertext into B's row.
    await deps.repo.updateProject(b.id, {
      tokenCiphertext: storedA?.tokenCiphertext,
      tokenIv: storedA?.tokenIv,
    });
    const res = await app.request(`/api/projects/${b.id}/stats`, { headers: OPERATOR });
    expect(res.status).toBe(502);
    // A's own stats still work.
    const okRes = await app.request(`/api/projects/${a.id}/stats`, { headers: OPERATOR });
    expect(okRes.status).toBe(200);
  });

  it("manual snapshot records today's total", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(projectPayload({ name: "Z", token: "12345678tok" })),
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
