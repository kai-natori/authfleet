import {
  AgentReadError,
  HttpAgentReader,
  InMemoryProjectRepository,
  importEncryptionKey,
  RemoteD1Reader,
} from "@authfleet/core";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../src/app";
import { createProjectReader } from "../src/reader";

/**
 * Registry + API behaviour for `agent` projects (add-agent-plugin
 * group 5). The plugin validation call and the stats reader are
 * injected stubs; reader construction branching is tested against the
 * real factories at the bottom.
 */

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const OPERATOR = { "x-authfleet-operator": "op@example.com", "content-type": "application/json" };
const API_KEY = "agent-api-key-0123456789abcdef-wxyz";
const BASE_URL = "https://app.example.com/api/auth";

function agentPayload(overrides: Record<string, unknown> = {}) {
  return { type: "agent", name: "Agent App", baseUrl: BASE_URL, apiKey: API_KEY, ...overrides };
}

function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    repo: new InMemoryProjectRepository(),
    getEncryptionKey: () => importEncryptionKey(KEY_B64),
    agentValidate: async () => ({ version: 1 }),
    readerFactory: () => ({
      getUserStats: async () => ({
        totalUsers: 777,
        anonymousUsers: null,
        dailySignups: [],
        asOf: new Date().toISOString(),
      }),
    }),
    ...overrides,
  };
}

describe("agent project registration", () => {
  it("creates an agent project; key is write-only, hint is last-4", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: Record<string, unknown>;
    };
    expect(body.project.type).toBe("agent");
    expect(body.project.baseUrl).toBe(BASE_URL);
    expect(body.project.tokenHint).toBe("wxyz");
    // Per-type fields that do not apply are omitted, and the key
    // itself appears nowhere in the response.
    expect(body.project).not.toHaveProperty("cfAccountId");
    expect(body.project).not.toHaveProperty("d1DatabaseId");
    expect(JSON.stringify(body)).not.toContain(API_KEY);

    const stored = await deps.repo.listProjects();
    expect(stored[0]?.type).toBe("agent");
    expect(stored[0]?.cfAccountId).toBeNull();
    expect(stored[0]?.d1DatabaseId).toBeNull();
    expect(stored[0]?.baseUrl).toBe(BASE_URL);
    expect(stored[0]?.tokenCiphertext).not.toContain("agent-api-key");
  });

  it("normalizes a trailing slash on the base URL", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload({ baseUrl: `${BASE_URL}/` })),
    });
    expect(res.status).toBe(201);
    const stored = await deps.repo.listProjects();
    expect(stored[0]?.baseUrl).toBe(BASE_URL);
  });

  it("refuses registration when the plugin check fails, storing nothing", async () => {
    const kinds: [AgentReadError, string][] = [
      [new AgentReadError("unreachable", "plugin is unreachable"), "could not reach"],
      [new AgentReadError("not-found", "plugin not found at this base URL"), "no AuthFleet plugin"],
      [new AgentReadError("unauthorized", "plugin rejected the API key"), "rejected the API key"],
      [
        new AgentReadError("version-mismatch", "plugin is newer than this dashboard", {
          contractVersion: 2,
        }),
        "newer than this dashboard",
      ],
    ];
    for (const [failure, expected] of kinds) {
      const deps = testDeps({
        agentValidate: async () => {
          throw failure;
        },
      });
      const app = createApp(deps);
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: OPERATOR,
        body: JSON.stringify(agentPayload()),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(expected);
      expect(await deps.repo.listProjects()).toHaveLength(0);
    }
  });

  it("rejects invalid agent payloads", async () => {
    const app = createApp(testDeps());
    for (const bad of [
      agentPayload({ baseUrl: "http://app.example.com/api/auth" }), // non-localhost http
      agentPayload({ baseUrl: "not a url" }),
      agentPayload({ apiKey: "too-short" }),
      agentPayload({ baseUrl: "" }),
      { type: "agent", name: "X" }, // missing fields
      { type: "carrier-pigeon", name: "X" }, // unknown type
    ]) {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: OPERATOR,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });

  it("allows http base URLs for localhost (local development)", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload({ baseUrl: "http://localhost:3000/api/auth" })),
    });
    expect(res.status).toBe(201);
  });
});

describe("agent project updates", () => {
  async function createAgentProject(deps: AppDeps) {
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload()),
    });
    const { project } = (await created.json()) as { project: { id: string } };
    return { app, id: project.id };
  }

  it("rotates the API key (write-only) and updates the base URL", async () => {
    const deps = testDeps();
    const { app, id } = await createAgentProject(deps);
    const newKey = "rotated-agent-key-0123456789abc-9876";
    const res = await app.request(`/api/projects/${id}`, {
      method: "PATCH",
      headers: OPERATOR,
      body: JSON.stringify({ apiKey: newKey, baseUrl: "https://other.example.com/auth" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: Record<string, unknown> };
    expect(body.project.tokenHint).toBe("9876");
    expect(body.project.baseUrl).toBe("https://other.example.com/auth");
    expect(JSON.stringify(body)).not.toContain(newKey);
  });

  it("re-validates the plugin on baseUrl/apiKey changes (plugin audit PA2)", async () => {
    let failValidation = false;
    const deps = testDeps({
      agentValidate: async () => {
        if (failValidation) {
          throw new AgentReadError("unreachable", "plugin is unreachable");
        }
        return { version: 1 };
      },
    });
    const { app, id } = await createAgentProject(deps);
    failValidation = true;

    // URL-only change: validated against the stored key.
    const urlRes = await app.request(`/api/projects/${id}`, {
      method: "PATCH",
      headers: OPERATOR,
      body: JSON.stringify({ baseUrl: "https://other.example.com/auth" }),
    });
    expect(urlRes.status).toBe(400);
    const urlBody = (await urlRes.json()) as { error: string };
    expect(urlBody.error).toContain("agent update failed");

    // Key-only change: validated against the stored URL.
    const keyRes = await app.request(`/api/projects/${id}`, {
      method: "PATCH",
      headers: OPERATOR,
      body: JSON.stringify({ apiKey: "another-agent-key-0123456789abcdef" }),
    });
    expect(keyRes.status).toBe(400);

    // Neither failed update touched the stored project.
    const stored = await deps.repo.getProject(id);
    expect(stored?.baseUrl).toBe(BASE_URL);
    expect(stored?.tokenHint).toBe("wxyz");

    // A name-only change does not need the plugin check and still works.
    failValidation = false;
    const nameRes = await app.request(`/api/projects/${id}`, {
      method: "PATCH",
      headers: OPERATOR,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(nameRes.status).toBe(200);
  });

  it("rejects type changes and foreign-type fields", async () => {
    const deps = testDeps();
    const { app, id } = await createAgentProject(deps);
    for (const bad of [
      { type: "d1" },
      { token: "cf-token-12345678" },
      { cfAccountId: "0123456789abcdef0123456789abcdef" },
    ]) {
      const res = await app.request(`/api/projects/${id}`, {
        method: "PATCH",
        headers: OPERATOR,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("agent project stats + snapshots", () => {
  it("serves stats via the injected reader and records manual snapshots", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload()),
    });
    const { project } = (await created.json()) as { project: { id: string } };

    const statsRes = await app.request(`/api/projects/${project.id}/stats`, {
      headers: OPERATOR,
    });
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      project: { type: string };
      summary: { stats: { totalUsers: number; anonymousUsers: null } };
    };
    expect(statsBody.project.type).toBe("agent");
    expect(statsBody.summary.stats.totalUsers).toBe(777);
    expect(statsBody.summary.stats.anonymousUsers).toBeNull();

    const snapRes = await app.request(`/api/projects/${project.id}/snapshot`, {
      method: "POST",
      headers: OPERATOR,
    });
    expect(snapRes.status).toBe(200);
    const snaps = await deps.repo.listSnapshots(project.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.totalUsers).toBe(777);
  });
});

describe("plugin status surfacing", () => {
  it("stats failures for agent projects expose the plugin status kind, never upstream detail", async () => {
    const deps = testDeps({
      readerFactory: () => ({
        getUserStats: async () => {
          throw new AgentReadError("not-found", "plugin not found at this base URL", {
            detail: "HTTP 404 from /authfleet/stats at https://internal.example.com",
          });
        },
      }),
    });
    const app = createApp(deps);
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload()),
    });
    const { project } = (await created.json()) as { project: { id: string } };
    const res = await app.request(`/api/projects/${project.id}/stats`, { headers: OPERATOR });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; pluginStatus?: string };
    expect(body.pluginStatus).toBe("not-found");
    expect(JSON.stringify(body)).not.toContain("internal.example.com");
  });
});

describe("reader construction branches on project type", () => {
  it("builds HttpAgentReader for agent projects and RemoteD1Reader for d1", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await app.request("/api/projects", {
      method: "POST",
      headers: OPERATOR,
      body: JSON.stringify(agentPayload()),
    });
    const [record] = await deps.repo.listProjects();
    expect(record).toBeDefined();
    if (!record) throw new Error("no record");
    expect(createProjectReader(record, API_KEY)).toBeInstanceOf(HttpAgentReader);

    const d1Reader = createProjectReader(
      { ...record, type: "d1", cfAccountId: "a".repeat(32), d1DatabaseId: "db", baseUrl: null },
      "cf-token",
    );
    expect(d1Reader).toBeInstanceOf(RemoteD1Reader);
  });
});
