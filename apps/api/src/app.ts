import {
  AgentReadError,
  buildStatsSummary,
  DEMO_PROJECT_ID,
  dateString,
  demoProject,
  demoSnapshots,
  demoStats,
  encryptText,
  HttpAgentReader,
  newId,
  normalizeAgentBaseUrl,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectStatsReader,
  projectTokenAad,
  tokenHint,
  toPublicProject,
} from "@authfleet/core";
import { Hono } from "hono";
import { z } from "zod";
import { createProjectReader, decryptProjectCredential } from "./reader";

/**
 * The api app. It is NOT a public API: in production the only caller is
 * the web Worker via a service binding (api has workers_dev=false and no
 * routes). Every /api call must carry the operator identity forwarded by
 * web in `x-authfleet-operator` (the Cloudflare Access email). The dev
 * bypass below exists for local development only.
 */

export interface AppDeps {
  repo: ProjectRepository;
  getEncryptionKey: () => Promise<CryptoKey>;
  demoEnabled?: boolean;
  devBypass?: boolean;
  devOperator?: string;
  /**
   * Operator allowlist (audit F2): when set (non-empty), only these
   * emails may call the api, whatever the Access policy in front of web
   * admits. Compared case-insensitively. Production wiring reads
   * AUTHFLEET_OPERATOR_EMAILS; when it is unset the gate falls back to
   * presence-only (and production wiring logs a warning) — set it.
   */
  operatorEmails?: string[];
  /** Injectable for tests; defaults to the per-type reader factory. */
  readerFactory?: (project: ProjectRecord, credential: string) => ProjectStatsReader;
  /**
   * Injectable for tests; defaults to a real HttpAgentReader
   * `/authfleet/validate` call. Runs BEFORE an `agent` project is
   * saved, so a typo'd URL or key fails at registration time.
   */
  agentValidate?: (baseUrl: string, apiKey: string) => Promise<{ version: number }>;
}

type Variables = { operator: string };

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

const d1UpdateSchema = z.object({
  name: nameSchema.optional(),
  cfAccountId: cfAccountIdSchema.optional(),
  d1DatabaseId: d1DatabaseIdSchema.optional(),
  token: z.string().trim().min(8).max(512).optional(),
});

const agentUpdateSchema = z.object({
  name: nameSchema.optional(),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  apiKey: z.string().trim().min(32).max(512).optional(),
});

type CreatePayload =
  | { type: "d1"; data: z.infer<typeof d1CreateSchema> }
  | { type: "agent"; data: z.infer<typeof agentCreateSchema> };

/**
 * Branch create-payload validation on the project type. A missing
 * `type` means `d1` (the v1 payload shape); an unknown type is a 400.
 */
function parseCreatePayload(body: unknown): CreatePayload | null {
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

function defaultReaderFactory(project: ProjectRecord, credential: string): ProjectStatsReader {
  return createProjectReader(project, credential);
}

function defaultAgentValidate(baseUrl: string, apiKey: string): Promise<{ version: number }> {
  return new HttpAgentReader({ baseUrl, apiKey }).validate();
}

/** Registration-time plugin check failures, phrased for the operator. */
function agentRegistrationError(cause: unknown): string {
  if (cause instanceof AgentReadError) {
    switch (cause.kind) {
      case "unreachable":
        return "agent registration failed: could not reach the plugin at the base URL";
      case "not-found":
        return "agent registration failed: no AuthFleet plugin found at the base URL (check the URL and that the plugin is installed)";
      case "unauthorized":
        return "agent registration failed: the plugin rejected the API key";
      case "version-mismatch":
        return `agent registration failed: ${cause.message}`;
      default:
        return "agent registration failed: the plugin returned an unexpected response";
    }
  }
  return "agent registration failed: plugin validation error";
}

export function createApp(deps: AppDeps) {
  const readerFactory = deps.readerFactory ?? defaultReaderFactory;
  const agentValidate = deps.agentValidate ?? defaultAgentValidate;
  const app = new Hono<{ Variables: Variables }>();

  app.get("/health", (c) => c.json({ ok: true, service: "authfleet-api" }));

  // Operator identity gate for everything under /api.
  const allowlist = deps.operatorEmails?.map((e) => e.trim().toLowerCase()).filter(Boolean);
  app.use("/api/*", async (c, next) => {
    const operator = c.req.header("x-authfleet-operator");
    if (operator) {
      // The identity must be email-shaped (audit F2): a bare string
      // proves nothing beyond "the caller could set a header".
      if (!/^[^\s@]+@[^\s@]+$/.test(operator)) {
        return c.json({ error: "operator identity invalid" }, 401);
      }
      // Second layer behind the Access policy (audit F2): when an
      // allowlist is configured, only listed operators get in.
      if (allowlist && allowlist.length > 0 && !allowlist.includes(operator.toLowerCase())) {
        return c.json({ error: "operator not allowed" }, 403);
      }
      c.set("operator", operator);
      return next();
    }
    if (deps.devBypass) {
      c.set("operator", deps.devOperator ?? "dev@local");
      return next();
    }
    return c.json({ error: "operator identity required" }, 401);
  });

  async function findProject(id: string): Promise<ProjectRecord | null> {
    if (deps.demoEnabled && id === DEMO_PROJECT_ID) return demoProject();
    return deps.repo.getProject(id);
  }

  async function readerFor(project: ProjectRecord): Promise<ProjectStatsReader> {
    const key = await deps.getEncryptionKey();
    const credential = await decryptProjectCredential(key, project);
    return readerFactory(project, credential);
  }

  app.get("/api/projects", async (c) => {
    const records = await deps.repo.listProjects();
    const projects = records.map(toPublicProject);
    if (deps.demoEnabled) projects.unshift(toPublicProject(demoProject()));
    // The operator identity is deliberately NOT echoed back (audit F8);
    // web displays the identity from its own verified Access JWT.
    return c.json({ projects });
  });

  app.post("/api/projects", async (c) => {
    const payload = parseCreatePayload(await c.req.json().catch(() => null));
    if (!payload) {
      return c.json({ error: "invalid project payload" }, 400);
    }
    // The row id is generated up front: the credential ciphertext is
    // AAD-bound to it (audit F5), so encryption needs the id first.
    const id = newId();
    const key = await deps.getEncryptionKey();

    if (payload.type === "agent") {
      let baseUrl: string;
      try {
        baseUrl = normalizeAgentBaseUrl(payload.data.baseUrl);
      } catch {
        return c.json(
          {
            error:
              "agent registration failed: baseUrl must be a valid https URL (http is allowed only for localhost)",
          },
          400,
        );
      }
      // Connectivity + contract check BEFORE anything is stored: a
      // typo'd URL or key fails here with a specific error, and no
      // project row is created (spec: agent registration scenario).
      try {
        await agentValidate(baseUrl, payload.data.apiKey);
      } catch (cause) {
        console.error(`agent validation failed for ${baseUrl}:`, cause);
        return c.json({ error: agentRegistrationError(cause) }, 400);
      }
      const encrypted = await encryptText(key, payload.data.apiKey, projectTokenAad(id));
      const record = await deps.repo.createProject({
        id,
        type: "agent",
        name: payload.data.name,
        cfAccountId: null,
        d1DatabaseId: null,
        baseUrl,
        tokenCiphertext: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenHint: tokenHint(payload.data.apiKey),
      });
      return c.json({ project: toPublicProject(record) }, 201);
    }

    const encrypted = await encryptText(key, payload.data.token, projectTokenAad(id));
    const record = await deps.repo.createProject({
      id,
      type: "d1",
      name: payload.data.name,
      cfAccountId: payload.data.cfAccountId,
      d1DatabaseId: payload.data.d1DatabaseId,
      baseUrl: null,
      tokenCiphertext: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenHint: tokenHint(payload.data.token),
    });
    return c.json({ project: toPublicProject(record) }, 201);
  });

  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (id === DEMO_PROJECT_ID) return c.json({ error: "demo project is read-only" }, 400);
    const existing = await deps.repo.getProject(id);
    if (!existing) return c.json({ error: "project not found" }, 404);
    const body = await c.req.json().catch(() => null);
    // A project's type is immutable: the credential semantics differ
    // per type, so changing type means delete + re-register. The
    // update schema branches on the EXISTING project's type, and
    // fields belonging to the other type are rejected outright (a
    // silently ignored credential field would look like a rotation
    // that never happened).
    if (typeof body === "object" && body !== null) {
      const fields = body as Record<string, unknown>;
      if ("type" in fields && fields.type !== existing.type) {
        return c.json({ error: "project type cannot be changed" }, 400);
      }
      const foreignFields =
        existing.type === "agent"
          ? ["token", "cfAccountId", "d1DatabaseId"]
          : ["apiKey", "baseUrl"];
      if (foreignFields.some((f) => f in fields)) {
        return c.json({ error: "invalid project payload" }, 400);
      }
    }
    const patch: Parameters<ProjectRepository["updateProject"]>[1] = {};
    let credential: string | undefined;
    if (existing.type === "agent") {
      const parsed = agentUpdateSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid project payload" }, 400);
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.baseUrl !== undefined) {
        try {
          patch.baseUrl = normalizeAgentBaseUrl(parsed.data.baseUrl);
        } catch {
          return c.json({ error: "invalid project payload" }, 400);
        }
      }
      credential = parsed.data.apiKey;
    } else {
      const parsed = d1UpdateSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid project payload" }, 400);
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.cfAccountId !== undefined) patch.cfAccountId = parsed.data.cfAccountId;
      if (parsed.data.d1DatabaseId !== undefined) patch.d1DatabaseId = parsed.data.d1DatabaseId;
      credential = parsed.data.token;
    }
    if (credential) {
      const key = await deps.getEncryptionKey();
      const encrypted = await encryptText(key, credential, projectTokenAad(id));
      patch.tokenCiphertext = encrypted.ciphertext;
      patch.tokenIv = encrypted.iv;
      patch.tokenHint = tokenHint(credential);
    }
    const updated = await deps.repo.updateProject(id, patch);
    if (!updated) return c.json({ error: "project not found" }, 404);
    return c.json({ project: toPublicProject(updated) });
  });

  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (id === DEMO_PROJECT_ID) return c.json({ error: "demo project is read-only" }, 400);
    const deleted = await deps.repo.deleteProject(id);
    if (!deleted) return c.json({ error: "project not found" }, 404);
    return c.json({ deleted: true });
  });

  app.get("/api/projects/:id/stats", async (c) => {
    const project = await findProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    if (project.isDemo) {
      const now = new Date();
      return c.json({
        project: toPublicProject(project),
        summary: buildStatsSummary(demoStats(now), demoSnapshots(now), now),
      });
    }
    try {
      const reader = await readerFor(project);
      const stats = await reader.getUserStats(30);
      const snapshots = await deps.repo.listSnapshots(project.id);
      return c.json({
        project: toPublicProject(project),
        summary: buildStatsSummary(stats, snapshots),
      });
    } catch (cause) {
      // Upstream detail stays in server-side logs only; clients get a
      // generic error (audit F3). One exception, by design: for agent
      // projects the AgentReadError KIND (AuthFleet's own taxonomy —
      // not-found / unreachable / version-mismatch / …) is returned as
      // `pluginStatus` so the dashboard can show first-class plugin
      // states instead of conflating them with a zero-user project.
      console.error(`failed to read stats for project ${project.id}:`, cause);
      if (project.type === "agent" && cause instanceof AgentReadError) {
        return c.json({ error: "failed to read project stats", pluginStatus: cause.kind }, 502);
      }
      return c.json({ error: "failed to read project stats" }, 502);
    }
  });

  app.get("/api/projects/:id/history", async (c) => {
    const project = await findProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const snapshots = project.isDemo ? demoSnapshots() : await deps.repo.listSnapshots(project.id);
    return c.json({ project: toPublicProject(project), snapshots });
  });

  app.post("/api/projects/:id/snapshot", async (c) => {
    const project = await findProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    if (project.isDemo) return c.json({ error: "demo project has no snapshots" }, 400);
    try {
      const reader = await readerFor(project);
      const stats = await reader.getUserStats(1);
      const snapshot = await deps.repo.upsertSnapshot(
        project.id,
        dateString(new Date()),
        stats.totalUsers,
      );
      return c.json({ snapshot });
    } catch (cause) {
      // Same rule as stats: detail server-side only (audit F3).
      console.error(`failed to snapshot project ${project.id}:`, cause);
      return c.json({ error: "failed to snapshot project" }, 502);
    }
  });

  return app;
}
