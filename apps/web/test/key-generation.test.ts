import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const builder = {
      validator: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://dashboard.example.com", {
      headers: { "cf-access-jwt-assertion": "test-assertion" },
    }),
}));

vi.mock("../src/server/access", () => ({ verifyAccessJwt: vi.fn() }));

import { verifyAccessJwt } from "../src/server/access";
import { generateAgentKeyFn } from "../src/server/api";

const generate = generateAgentKeyFn as unknown as () => Promise<{
  apiKey: string;
  apiKeyHash: string;
}>;

describe("plugin key generation identity gate", () => {
  beforeEach(() => {
    vi.stubEnv("AUTHFLEET_ACCESS_TEAM_DOMAIN", "");
    vi.stubEnv("AUTHFLEET_ACCESS_AUD", "");
    vi.stubEnv("AUTHFLEET_DEV_BYPASS", "");
    vi.mocked(verifyAccessJwt).mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects callers without an identity", async () => {
    await expect(generate()).rejects.toThrow("operator identity required");
  });

  it("generates a key and matching hash after Access verification", async () => {
    vi.stubEnv("AUTHFLEET_ACCESS_TEAM_DOMAIN", "team.cloudflareaccess.com");
    vi.stubEnv("AUTHFLEET_ACCESS_AUD", "audience");
    vi.mocked(verifyAccessJwt).mockResolvedValue({ email: "op@example.com" });
    const result = await generate();
    expect(verifyAccessJwt).toHaveBeenCalledWith("test-assertion", {
      teamDomain: "team.cloudflareaccess.com",
      audience: "audience",
    });
    expect(result.apiKey).toHaveLength(43);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.apiKey));
    expect(result.apiKeyHash).toBe(
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
  });

  it("never falls back to dev bypass when verification fails", async () => {
    vi.stubEnv("AUTHFLEET_ACCESS_TEAM_DOMAIN", "team.cloudflareaccess.com");
    vi.stubEnv("AUTHFLEET_ACCESS_AUD", "audience");
    vi.stubEnv("AUTHFLEET_DEV_BYPASS", "1");
    vi.mocked(verifyAccessJwt).mockRejectedValue(new Error("invalid JWT"));
    await expect(generate()).rejects.toThrow("invalid JWT");
  });
});
