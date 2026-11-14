import { beforeAll, describe, expect, it } from "vitest";
import { AccessVerificationError, verifyAccessJwt } from "../src/server/access";

/**
 * Unit tests for Cloudflare Access JWT verification (audit F1). A real
 * RSA keypair is generated in-test; the team JWKS endpoint is stubbed
 * with the matching public JWK, so signature checks are genuine.
 */

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";
const KID = "test-key-1";
const NOW = 1_800_000_000; // fixed clock for deterministic exp checks

let privateKey: CryptoKey;
let jwksFetch: typeof fetch;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function jsonPart(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function signJwt(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" },
): Promise<string> {
  const unsigned = `${jsonPart(header)}.${jsonPart(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUDIENCE,
    exp: NOW + 3600,
    iat: NOW,
    email: "op@example.com",
    sub: "user-123",
    ...overrides,
  };
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };
  jwksFetch = (async (url: unknown) => {
    expect(String(url)).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return { ok: true, status: 200, json: async () => jwks } as Response;
  }) as typeof fetch;
});

function verify(assertion: string) {
  return verifyAccessJwt(
    assertion,
    { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
    { fetchFn: jwksFetch, nowSeconds: NOW, bypassCache: true },
  );
}

describe("verifyAccessJwt", () => {
  it("accepts a valid Access JWT and returns the verified email", async () => {
    const claims = await verify(await signJwt(validClaims()));
    expect(claims.email).toBe("op@example.com");
    expect(claims.sub).toBe("user-123");
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const token = await signJwt(validClaims());
    const [header, , signature] = token.split(".");
    const forged = `${header}.${jsonPart(validClaims({ email: "attacker@example.com" }))}.${signature}`;
    await expect(verify(forged)).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it("rejects a wrong audience", async () => {
    await expect(verify(await signJwt(validClaims({ aud: "another-app" })))).rejects.toThrow(
      /audience/,
    );
  });

  it("accepts an audience array containing the configured AUD", async () => {
    const claims = await verify(await signJwt(validClaims({ aud: ["other", AUDIENCE] })));
    expect(claims.email).toBe("op@example.com");
  });

  it("rejects an expired token", async () => {
    await expect(verify(await signJwt(validClaims({ exp: NOW - 10 })))).rejects.toThrow(/expired/);
  });

  it("rejects a wrong issuer", async () => {
    await expect(
      verify(await signJwt(validClaims({ iss: "https://evil.example.com" }))),
    ).rejects.toThrow(/issuer/);
  });

  it("rejects an unknown signing key id", async () => {
    await expect(
      verify(await signJwt(validClaims(), { alg: "RS256", kid: "no-such-key", typ: "JWT" })),
    ).rejects.toThrow(/signing key/);
  });

  it("rejects a token without an email claim", async () => {
    const claims = validClaims();
    delete claims.email;
    await expect(verify(await signJwt(claims))).rejects.toThrow(/email/);
  });

  it("rejects malformed assertions", async () => {
    await expect(verify("not-a-jwt")).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(verify("")).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it("rejects a non-RS256 algorithm", async () => {
    await expect(
      verify(await signJwt(validClaims(), { alg: "HS256", kid: KID, typ: "JWT" })),
    ).rejects.toThrow(/alg/);
  });
});
