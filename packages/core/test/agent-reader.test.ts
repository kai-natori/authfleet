import { describe, expect, it } from "vitest";
import { AgentReadError, HttpAgentReader, normalizeAgentBaseUrl } from "../src/agent-reader";

const KEY = "agent-api-key-0123456789abcdef";
const BASE = "https://app.example.com/api/auth";

const STATS_BODY = {
  version: 1,
  totalUsers: 42,
  anonymousUsers: 7,
  dailySignups: [{ date: "2026-11-15", count: 3 }],
  asOf: "2026-11-15T00:00:00.000Z",
};

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    return handler(u, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reader(fetchFn: typeof fetch, baseUrl = BASE) {
  return new HttpAgentReader({ baseUrl, apiKey: KEY, fetchFn });
}

describe("normalizeAgentBaseUrl", () => {
  it("accepts https and strips trailing slashes", () => {
    expect(normalizeAgentBaseUrl("https://app.example.com/api/auth/")).toBe(
      "https://app.example.com/api/auth",
    );
    expect(normalizeAgentBaseUrl("https://app.example.com")).toBe("https://app.example.com");
  });

  it("allows http only for localhost", () => {
    expect(normalizeAgentBaseUrl("http://localhost:3000/api/auth")).toBe(
      "http://localhost:3000/api/auth",
    );
    expect(normalizeAgentBaseUrl("http://127.0.0.1:8787/api/auth")).toBe(
      "http://127.0.0.1:8787/api/auth",
    );
    expect(() => normalizeAgentBaseUrl("http://app.example.com/api/auth")).toThrow(/https/);
  });

  it("rejects invalid URLs and embedded credentials", () => {
    expect(() => normalizeAgentBaseUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => normalizeAgentBaseUrl("https://user:pass@app.example.com")).toThrow(/credentials/);
  });
});

describe("HttpAgentReader — happy path", () => {
  it("validate returns the contract version and sends the Bearer key", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ ok: true, version: 1 }));
    await expect(reader(fetchFn).validate()).resolves.toEqual({ version: 1 });
    expect(calls[0]?.url).toBe(`${BASE}/authfleet/validate`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("getUserStats maps the contract body to UserStats (version stripped)", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(STATS_BODY));
    const stats = await reader(fetchFn).getUserStats(30);
    expect(stats).toEqual({
      totalUsers: 42,
      anonymousUsers: 7,
      dailySignups: [{ date: "2026-11-15", count: 3 }],
      asOf: "2026-11-15T00:00:00.000Z",
    });
    expect(calls[0]?.url).toBe(`${BASE}/authfleet/stats?days=30`);
  });

  it("clamps days into [1, 90] in the request URL", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse(STATS_BODY));
    await reader(fetchFn).getUserStats(365);
    expect(calls[0]?.url).toContain("days=90");
  });

  it("accepts anonymousUsers: null", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ ...STATS_BODY, anonymousUsers: null }));
    const stats = await reader(fetchFn).getUserStats();
    expect(stats.anonymousUsers).toBeNull();
  });
});

describe("HttpAgentReader — typed errors (F3 discipline)", () => {
  it("fetch failure → unreachable, cause kept in detail only", async () => {
    const { fetchFn } = stubFetch(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443");
    });
    const err = await reader(fetchFn)
      .getUserStats()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentReadError);
    const agentErr = err as AgentReadError;
    expect(agentErr.kind).toBe("unreachable");
    expect(agentErr.message).toBe("plugin is unreachable");
    expect(agentErr.message).not.toContain("ECONNREFUSED");
    expect(agentErr.detail).toContain("ECONNREFUSED");
  });

  it("401 → unauthorized; 404 → not-found; 500 → upstream", async () => {
    const cases: [number, string][] = [
      [401, "unauthorized"],
      [404, "not-found"],
      [500, "upstream"],
    ];
    for (const [status, kind] of cases) {
      const { fetchFn } = stubFetch(() =>
        jsonResponse({ code: "SOME_PLUGIN_DETAIL", message: "secret internals" }, status),
      );
      const err = (await reader(fetchFn)
        .getUserStats()
        .catch((e: unknown) => e)) as AgentReadError;
      expect(err).toBeInstanceOf(AgentReadError);
      expect(err.kind).toBe(kind);
      // The plugin's error body is never forwarded, even in detail.
      expect(err.message).not.toContain("secret internals");
      expect(err.detail ?? "").not.toContain("secret internals");
    }
  });

  it("newer contract version → version-mismatch naming the upgrade direction", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ ...STATS_BODY, version: 2 }));
    const err = (await reader(fetchFn)
      .getUserStats()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err.kind).toBe("version-mismatch");
    expect(err.contractVersion).toBe(2);
    expect(err.message).toMatch(/upgrade AuthFleet/);
  });

  it("older/unknown contract version → version-mismatch", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ ...STATS_BODY, version: 0 }));
    const err = (await reader(fetchFn)
      .getUserStats()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err.kind).toBe("version-mismatch");
    expect(err.contractVersion).toBe(0);
  });

  it("validate applies the same version rules", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ ok: true, version: 99 }));
    const err = (await reader(fetchFn)
      .validate()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err.kind).toBe("version-mismatch");
  });

  it("malformed bodies → malformed (bad JSON, missing fields, bad entries)", async () => {
    const badJson = stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    const err1 = (await reader(badJson.fetchFn)
      .getUserStats()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err1.kind).toBe("malformed");

    const missing = stubFetch(() => jsonResponse({ version: 1, totalUsers: "many" }));
    const err2 = (await reader(missing.fetchFn)
      .getUserStats()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err2.kind).toBe("malformed");

    const badEntry = stubFetch(() =>
      jsonResponse({ ...STATS_BODY, dailySignups: [{ date: "15/11/2026", count: 1 }] }),
    );
    const err3 = (await reader(badEntry.fetchFn)
      .getUserStats()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err3.kind).toBe("malformed");
  });
});
