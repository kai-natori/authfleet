/**
 * Credential encryption for stored project API tokens.
 *
 * AES-GCM via WebCrypto (available in Workers and modern Node).
 * The key comes from the TOKEN_ENCRYPTION_KEY Worker secret (base64,
 * 32 bytes). Ciphertext and IV are stored base64-encoded in D1.
 * Ciphertexts are bound to their project row via AAD (see
 * `projectTokenAad`). Plaintext tokens are never logged anywhere in
 * this codebase.
 */

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key.trim());
  if (raw.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${raw.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Versioned AES-GCM additional authenticated data (AAD) binding a stored
 * project token to its registry row. A ciphertext transplanted into a
 * different project's row will not decrypt (audit F5). This is a storage
 * format: changing the context string invalidates existing ciphertexts.
 */
export function projectTokenAad(projectId: string): string {
  return `authfleet:project-token:v1:${projectId}`;
}

export async function encryptText(
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) as BufferSource },
    key,
    encoded,
  );
  return { ciphertext: bytesToBase64(new Uint8Array(cipher)), iv: bytesToBase64(iv) };
}

export async function decryptText(
  key: CryptoKey,
  value: EncryptedValue,
  aad: string,
): Promise<string> {
  const iv = base64ToBytes(value.iv);
  // WebCrypto accepts other IV lengths for AES-GCM; this codebase only
  // ever writes 96-bit IVs, so reject anything else outright (audit F5).
  if (iv.length !== 12) {
    throw new Error(`stored token IV must be 12 bytes (got ${iv.length})`);
  }
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: new TextEncoder().encode(aad) as BufferSource,
    },
    key,
    base64ToBytes(value.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/**
 * High-entropy random token (base64url). This — never a ULID — is the
 * only acceptable generator for anything that grants access.
 */
export function generateRandomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Last 4 characters, safe to display ("…ab12"). Never store more. */
export function tokenHint(token: string): string {
  return token.slice(-4);
}
