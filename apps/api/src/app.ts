import {
  buildStatsSummary,
  DEMO_PROJECT_ID,
  dateString,
  demoProject,
  demoSnapshots,
  demoStats,
  encryptText,
  newId,
  type ProjectRecord,
  type ProjectRepository,
  projectTokenAad,
  tokenHint,
  toPublicProject,
  type UserStats,
} from "@authfleet/core";
import { Hono } from "hono";
import { z } from "zod";
import { createProjectReader, decryptProjectToken } from "./reader";

/**
 * The api app. It is NOT a public API: in production the only caller is
 * the web Worker via a service binding (api has workers_dev=false and no
 * routes). Every /api call must carry the operator identity forwarded by
 * web in `x-authfleet-operator` (the Cloudflare Access email). The dev
 * bypass below exists for local development only.
 */

export interface StatsReader {
  getUserStats(days?: number): Promise<UserStats>;
}

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
  /** Injectable for tests; defaults to the real remote D1 reader. */
  readerFactory?: (project: ProjectRecord, token: string) => StatsReader;
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

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cfAccountId: cfAccountIdSchema,
  d1DatabaseId: d1DatabaseIdSchema,
  token: z.string().trim().min(8).max(512),
});

const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  cfAccountId: cfAccountIdSchema.optional(),
  d1DatabaseId: d1DatabaseIdSchema.optional(),
  token: z.string().trim().min(8).max(512).optional(),
});

function defaultReaderFactory(project: ProjectRecord, token: string): StatsReader {
  return createProjectReader(project, token);
}

export function createApp(deps: AppDeps) {
  const readerFactory = deps.readerFactory ?? defaultReaderFactory;
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

  async function readerFor(project: ProjectRecord): Promise<StatsReader> {
    const key = await deps.getEncryptionKey();
    const token = await decryptProjectToken(key, project);
    return readerFactory(project, token);
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
    const parsed = projectCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid project payload", issues: parsed.error.issues }, 400);
    }
    // The row id is generated up front: the token ciphertext is
    // AAD-bound to it (audit F5), so encryption needs the id first.
    const id = newId();
    const key = await deps.getEncryptionKey();
    const encrypted = await encryptText(key, parsed.data.token, projectTokenAad(id));
    const record = await deps.repo.createProject({
      id,
      name: parsed.data.name,
      cfAccountId: parsed.data.cfAccountId,
      d1DatabaseId: parsed.data.d1DatabaseId,
      tokenCiphertext: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenHint: tokenHint(parsed.data.token),
    });
    return c.json({ project: toPublicProject(record) }, 201);
  });

  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (id === DEMO_PROJECT_ID) return c.json({ error: "demo project is read-only" }, 400);
    const parsed = projectUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid project payload", issues: parsed.error.issues }, 400);
    }
    const { token, ...rest } = parsed.data;
    const patch: Parameters<ProjectRepository["updateProject"]>[1] = { ...rest };
    if (token) {
      const key = await deps.getEncryptionKey();
      const encrypted = await encryptText(key, token, projectTokenAad(id));
      patch.tokenCiphertext = encrypted.ciphertext;
      patch.tokenIv = encrypted.iv;
      patch.tokenHint = tokenHint(token);
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
      // Upstream (Cloudflare) detail stays in server-side logs only;
      // clients get a generic error (audit F3).
      console.error(`failed to read stats for project ${project.id}:`, cause);
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
