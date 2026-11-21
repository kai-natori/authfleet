import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => ({
    validator() {
      return this;
    },
    handler: (fn: unknown) => fn,
  }),
}));

import { callApi, getProjectStatsFn } from "../src/server/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function respond(body: unknown, status = 200) {
  vi.stubEnv("AUTHFLEET_ACCESS_TEAM_DOMAIN", "");
  vi.stubEnv("AUTHFLEET_ACCESS_AUD", "");
  vi.stubEnv("AUTHFLEET_DEV_BYPASS", "");
  vi.stubGlobal("__AUTHFLEET_ENV__", undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

describe("API response handling", () => {
  it("returns successful response data", async () => {
    respond({ projects: [] });
    expect(await callApi("/api/projects")).toEqual({ projects: [] });
  });

  it("preserves recognized plugin status errors", async () => {
    respond({ error: "failed to read project stats", pluginStatus: "not-found" }, 502);
    await expect(getProjectStatsFn({ data: "project" })).resolves.toEqual({
      ok: false,
      error: "failed to read project stats",
      pluginStatus: "not-found",
    });
  });

  it("drops unrecognized statuses", async () => {
    respond({ error: "failed", pluginStatus: "unknown" }, 502);
    expect(await getProjectStatsFn({ data: "project" })).toEqual({
      ok: false,
      error: "failed",
      pluginStatus: null,
    });
  });

  it("uses the HTTP fallback for non-JSON errors", async () => {
    respond(null);
    vi.mocked(fetch).mockResolvedValue(new Response("bad gateway", { status: 502 }));
    await expect(callApi("/api/projects")).rejects.toThrow("AuthFleet api error: HTTP 502");
  });

  it("preserves ordinary errors and handles non-error exceptions", async () => {
    respond(null);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(null);
    expect(await getProjectStatsFn({ data: "project" })).toEqual({
      ok: false,
      error: "offline",
      pluginStatus: null,
    });
    expect(await getProjectStatsFn({ data: "project" })).toEqual({
      ok: false,
      error: "failed to read project stats",
      pluginStatus: null,
    });
  });
});
