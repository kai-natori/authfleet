import { describe, expect, it } from "vitest";
import {
  decryptText,
  encryptText,
  generateRandomToken,
  importEncryptionKey,
  tokenHint,
} from "../src/crypto";
import { newId } from "../src/ids";

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const OTHER_KEY_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

describe("crypto", () => {
  it("round-trips AES-GCM encryption", async () => {
    const key = await importEncryptionKey(KEY_B64);
    const encrypted = await encryptText(key, "cf-token-secret-value");
    expect(encrypted.ciphertext).not.toContain("cf-token-secret-value");
    await expect(decryptText(key, encrypted)).resolves.toBe("cf-token-secret-value");
  });

  it("uses a random IV per record", async () => {
    const key = await importEncryptionKey(KEY_B64);
    const a = await encryptText(key, "same");
    const b = await encryptText(key, "same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = await importEncryptionKey(KEY_B64);
    const other = await importEncryptionKey(OTHER_KEY_B64);
    const encrypted = await encryptText(key, "secret");
    await expect(decryptText(other, encrypted)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importEncryptionKey(Buffer.from("short").toString("base64"))).rejects.toThrow(
      /32 bytes/,
    );
  });

  it("generates high-entropy url-safe tokens", () => {
    const a = generateRandomToken();
    const b = generateRandomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("token hint is the last 4 characters", () => {
    expect(tokenHint("abcdef1234")).toBe("1234");
  });
});

describe("ids", () => {
  it("creates lowercase ULIDs", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect(id).toBe(id.toLowerCase());
  });

  it("creates time-ordered ids", () => {
    const a = newId();
    const b = newId();
    expect(b >= a).toBe(true);
  });
});
