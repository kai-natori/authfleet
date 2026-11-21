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

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://dashboard.example.com", {
      headers: {
        "cf-access-jwt-assertion": "test-assertion",
        "cf-access-authenticated-user-email": "spoofed@example.com",
      },
    }),
}));

vi.mock("../src/server/access", () => ({ verifyAccessJwt: vi.fn() }));

import { verifyAccessJwt } from "../src/server/access";
import { callApi, getProjectStatsFn } from "../src/server/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(verifyAccessJwt).mockReset();
});

describe("operator forwarding through the service binding", () => {
  function configureAccess() {
    vi.stubEnv("AUTHFLEET_ACCESS_TEAM_DOMAIN", "team.cloudflareaccess.com");
    vi.stubEnv("AUTHFLEET_ACCESS_AUD", "audience");
    vi.stubEnv("AUTHFLEET_DEV_BYPASS", "1");
    const binding = vi.fn().mockResolvedValue(new Response(JSON.stringify({ projects: [] })));
    vi.stubGlobal("__AUTHFLEET_ENV__", { API: { fetch: binding } });
    vi.stubGlobal("fetch", vi.fn());
    return binding;
  }

  it("forwards only the verified identity and uses the binding", async () => {
    const binding = configureAccess();
    vi.mocked(verifyAccessJwt).mockResolvedValue({ email: "verified@example.com" });
    await callApi("/api/projects", {
      headers: { "x-authfleet-operator": "spoofed@example.com" },
    });
    const request = binding.mock.calls[0]?.[0] as Request;
    expect(request.headers.get("x-authfleet-operator")).toBe("verified@example.com");
    expect(verifyAccessJwt).toHaveBeenCalledWith("test-assertion", {
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not forward a failed JWT despite the dev bypass", async () => {
    const binding = configureAccess();
    vi.mocked(verifyAccessJwt).mockRejectedValue(new Error("invalid JWT"));
    await expect(callApi("/api/projects")).rejects.toThrow("invalid JWT");
    expect(binding).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not forward partially configured Access requests", async () => {
    const binding = configureAccess();
    vi.stubEnv("AUTHFLEET_ACCESS_AUD", "");
    await expect(callApi("/api/projects")).rejects.toThrow("partially configured");
    expect(binding).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
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
