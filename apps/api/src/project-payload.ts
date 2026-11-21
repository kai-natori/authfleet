import { z } from "zod";

/** Cloudflare account ids are 32 hex characters (audit F4). */
const cfAccountIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{32}$/, "cfAccountId must be a 32-character hex Cloudflare account id");

/** D1 database ids are UUIDs (audit F4). */
const d1DatabaseIdSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "d1DatabaseId must be a UUID",
  );

const nameSchema = z.string().trim().min(1).max(120);

/** `d1` registration: Cloudflare account/database ids + read-only token. */
const d1CreateSchema = z.object({
  name: nameSchema,
  cfAccountId: cfAccountIdSchema,
  d1DatabaseId: d1DatabaseIdSchema,
  token: z.string().trim().min(8).max(512),
});

/** `agent` registration: the app's Better Auth base URL + plugin API key. */
const agentCreateSchema = z.object({
  name: nameSchema,
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().min(32).max(512),
});

export const d1UpdateSchema = d1CreateSchema.partial();

export const agentUpdateSchema = agentCreateSchema.partial();

type CreatePayload =
  | { type: "d1"; data: z.infer<typeof d1CreateSchema> }
  | { type: "agent"; data: z.infer<typeof agentCreateSchema> };

/**
 * Branch create-payload validation on the project type. A missing
 * `type` means `d1` (the v1 payload shape); an unknown type is a 400.
 */
export function parseCreatePayload(body: unknown): CreatePayload | null {
  if (typeof body !== "object" || body === null) return null;
  const type = (body as { type?: unknown }).type;
  if (type === undefined || type === "d1") {
    const parsed = d1CreateSchema.safeParse(body);
    return parsed.success ? { type: "d1", data: parsed.data } : null;
  }
  if (type === "agent") {
    const parsed = agentCreateSchema.safeParse(body);
    return parsed.success ? { type: "agent", data: parsed.data } : null;
  }
  return null;
}
