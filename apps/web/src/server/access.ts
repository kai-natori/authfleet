/**
 * Cloudflare Access JWT verification (audit F1).
 *
 * Cloudflare Access injects two identity headers in front of this app:
 * `Cf-Access-Authenticated-User-Email` (plain, spoofable wherever a
 * request reaches the Worker without traversing Access) and
 * `Cf-Access-Jwt-Assertion` (a signed JWT). Only the JWT is trusted:
 * the operator email forwarded to the api comes from its VERIFIED
 * claims, never from the plain header.
 *
 * Verification follows Cloudflare's documented scheme: RS256 signature
 * against the team JWKS at `https://<team>/cdn-cgi/access/certs`,
 * issuer `https://<team>`, audience = the Access application's AUD tag,
 * plus expiry. JWKS responses are cached in-isolate and refetched when
 * an unknown `kid` shows up (key rotation).
 */

export interface AccessConfig {
  /** e.g. "your-team.cloudflareaccess.com" (no scheme). */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
}

export interface AccessClaims {
  email: string;
  sub?: string;
}

export class AccessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessVerificationError";
  }
}

type JwkWithKid = JsonWebKey & { kid?: string };

interface Jwks {
  keys: JwkWithKid[];
}

export interface VerifyAccessJwtOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Seconds since epoch; injectable for tests. */
  nowSeconds?: number;
  /** Skip the in-isolate JWKS cache (tests). */
  bypassCache?: boolean;
}

const jwksCache = new Map<string, { jwks: Jwks; fetchedAtMs: number }>();
const JWKS_TTL_MS = 10 * 60 * 1000;

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  const text = new TextDecoder().decode(base64UrlToBytes(part));
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new AccessVerificationError("Access JWT part is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function fetchJwks(teamDomain: string, fetchFn: typeof fetch): Promise<Jwks> {
  const response = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new AccessVerificationError(`could not fetch Access JWKS (HTTP ${response.status})`);
  }
  const body = (await response.json()) as Jwks;
  if (!body || !Array.isArray(body.keys)) {
    throw new AccessVerificationError("Access JWKS response has no keys");
  }
  return body;
}

async function getJwks(
  teamDomain: string,
  fetchFn: typeof fetch,
  bypassCache: boolean,
): Promise<Jwks> {
  if (!bypassCache) {
    const cached = jwksCache.get(teamDomain);
    if (cached && Date.now() - cached.fetchedAtMs < JWKS_TTL_MS) return cached.jwks;
  }
  const jwks = await fetchJwks(teamDomain, fetchFn);
  jwksCache.set(teamDomain, { jwks, fetchedAtMs: Date.now() });
  return jwks;
}

async function findKey(
  teamDomain: string,
  kid: string,
  fetchFn: typeof fetch,
  bypassCache: boolean,
): Promise<JwkWithKid> {
  let jwks = await getJwks(teamDomain, fetchFn, bypassCache);
  let key = jwks.keys.find((k) => k.kid === kid);
  if (!key && !bypassCache) {
    // Possibly a rotated key: refetch once, bypassing the cache.
    jwks = await fetchJwks(teamDomain, fetchFn);
    jwksCache.set(teamDomain, { jwks, fetchedAtMs: Date.now() });
    key = jwks.keys.find((k) => k.kid === kid);
  }
  if (!key) throw new AccessVerificationError("Access JWT signing key not found in team JWKS");
  return key;
}

/**
 * Verify a `Cf-Access-Jwt-Assertion` value. Resolves with the verified
 * claims; rejects with AccessVerificationError on ANY problem (missing
 * parts, wrong algorithm, bad signature, wrong issuer/audience,
 * expired, no email). Fails closed by construction.
 */
export async function verifyAccessJwt(
  assertion: string,
  config: AccessConfig,
  options: VerifyAccessJwtOptions = {},
): Promise<AccessClaims> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const teamDomain = config.teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const parts = assertion.split(".");
  if (parts.length !== 3) throw new AccessVerificationError("Access JWT is malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJsonPart(headerPart);
  if (header.alg !== "RS256") {
    throw new AccessVerificationError(`unexpected Access JWT alg: ${String(header.alg)}`);
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new AccessVerificationError("Access JWT has no kid");
  }

  const jwk = await findKey(teamDomain, header.kid, fetchFn, options.bypassCache ?? false);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    base64UrlToBytes(signaturePart) as BufferSource,
    signed as BufferSource,
  );
  if (!valid) throw new AccessVerificationError("Access JWT signature verification failed");

  const claims = decodeJsonPart(payloadPart);
  if (claims.iss !== `https://${teamDomain}`) {
    throw new AccessVerificationError("Access JWT issuer mismatch");
  }
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.audience)) {
    throw new AccessVerificationError("Access JWT audience mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new AccessVerificationError("Access JWT is expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now) {
    throw new AccessVerificationError("Access JWT is not yet valid");
  }
  if (typeof claims.email !== "string" || claims.email.length === 0) {
    throw new AccessVerificationError("Access JWT has no email claim");
  }
  return {
    email: claims.email,
    sub: typeof claims.sub === "string" ? claims.sub : undefined,
  };
}
