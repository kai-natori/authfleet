/**
 * API-key verification for the AuthFleet plugin endpoints.
 *
 * The plugin is configured with only the hex SHA-256 of the project's
 * API key — never the key itself. A presented Bearer key is hashed and
 * the two fixed-length digests are compared in constant time, so the
 * comparison leaks neither the key nor the configured hash. Nothing in
 * this module logs: the key and the Authorization header must never
 * reach a log line (see the package README's threat notes).
 */

const textEncoder = new TextEncoder();

/** Hex-encoded SHA-256 of a string, via WebCrypto (Node ≥19, Workers). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A configured hash is exactly one SHA-256 digest, hex-encoded. */
export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time equality for two hex digests. Both inputs are digests
 * produced/validated as 64-char hex, so length is not secret; the loop
 * still runs over the full input to avoid early-exit timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bytesA = hexToBytes(a);
  const bytesB = hexToBytes(b);
  let diff = bytesA.length ^ bytesB.length;
  const len = Math.max(bytesA.length, bytesB.length);
  for (let i = 0; i < len; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Check an Authorization header against the configured key hash.
 * Returns a bare boolean: callers answer every failure with the same
 * generic 401, never revealing which check failed.
 */
export async function verifyBearerKey(
  headers: Headers | undefined,
  apiKeyHash: string,
): Promise<boolean> {
  const header = headers?.get("authorization");
  if (!header) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const presentedHash = await sha256Hex(match[1]);
  return timingSafeEqualHex(presentedHash, apiKeyHash);
}
