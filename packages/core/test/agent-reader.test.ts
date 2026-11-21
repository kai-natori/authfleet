import { describe, expect, it, vi } from "vitest";
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

  it("rejects query strings and fragments (plugin audit PA3)", () => {
    expect(() => normalizeAgentBaseUrl("https://app.example.com/api/auth?x=1")).toThrow(/query/);
    expect(() => normalizeAgentBaseUrl("https://app.example.com/api/auth#frag")).toThrow(
      /query string or fragment/,
    );
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
  it("uses a 10-second deadline and reports aborted fetches generically", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const { fetchFn } = stubFetch((_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(KEY)));
          controller.abort();
        });
      });
      await expect(reader(fetchFn).validate()).rejects.toMatchObject({
        kind: "unreachable",
        message: "plugin is unreachable",
      });
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("aborts a stalled response body using the same deadline", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    try {
      const { fetchFn } = stubFetch(
        () =>
          new Response(
            new ReadableStream({
              pull() {
                queueMicrotask(() => controller.abort());
              },
              cancel,
            }),
          ),
      );
      await expect(reader(fetchFn).getUserStats()).rejects.toMatchObject({
        kind: "unreachable",
        message: "plugin is unreachable",
      });
      expect(cancel).toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("bounds streamed body bytes without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const { fetchFn } = stubFetch(() => {
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(512 * 1024));
          },
          cancel,
        }),
        { headers: { "content-length": "1" } },
      );
    });
    await expect(reader(fetchFn).validate()).rejects.toMatchObject({
      kind: "malformed",
      message: "plugin returned a malformed response",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts exactly 1 MiB and rejects an additional byte", async () => {
    const json = JSON.stringify({ ok: true, version: 1 });
    for (const extra of [0, 1]) {
      const { fetchFn } = stubFetch(
        () => new Response(json + " ".repeat(1024 * 1024 - json.length + extra)),
      );
      if (extra === 0) {
        await expect(reader(fetchFn).validate()).resolves.toEqual({ version: 1 });
      } else {
        await expect(reader(fetchFn).validate()).rejects.toMatchObject({ kind: "malformed" });
      }
    }
  });

  it("accepts 91 UTC dates in a 90-day window and rejects 92 buckets", async () => {
    for (const count of [0, 90, 91, 92]) {
      const { fetchFn } = stubFetch(() =>
        jsonResponse({
          ...STATS_BODY,
          dailySignups: Array.from({ length: count }, (_, day) => ({
            date: new Date(Date.parse(STATS_BODY.asOf) - day * 86_400_000)
              .toISOString()
              .slice(0, 10),
            count: 1,
          })),
        }),
      );
      if (count <= 91) {
        expect((await reader(fetchFn).getUserStats(90)).dailySignups).toHaveLength(count);
      } else {
        await expect(reader(fetchFn).getUserStats(90)).rejects.toMatchObject({ kind: "malformed" });
      }
    }
  });

  it("reports an empty or failed body generically", async () => {
    const empty = stubFetch(() => new Response(null));
    await expect(reader(empty.fetchFn).validate()).rejects.toMatchObject({ kind: "malformed" });
    const failed = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(KEY));
            },
          }),
        ),
    );
    await expect(reader(failed.fetchFn).validate()).rejects.toMatchObject({
      kind: "unreachable",
      message: "plugin is unreachable",
    });
  });

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

  it("redirects are never followed and surface as upstream (plugin audit PA1)", async () => {
    const { fetchFn, calls } = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    const err = (await reader(fetchFn)
      .getUserStats()
      .catch((e: unknown) => e)) as AgentReadError;
    expect(err).toBeInstanceOf(AgentReadError);
    expect(err.kind).toBe("upstream");
    expect(err.detail ?? "").toContain("302");
    // Exactly one request, issued with redirect: "manual".
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
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
