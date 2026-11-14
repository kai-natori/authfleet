import {
  buildStatsSummary,
  DEMO_PROJECT_ID,
  dateString,
  decryptText,
  demoProject,
  demoSnapshots,
  demoStats,
  encryptText,
  type ProjectRecord,
  type ProjectRepository,
  RemoteD1Reader,
  tokenHint,
  toPublicProject,
  type UserStats,
} from "@authfleet/core";
import { Hono } from "hono";
import { z } from "zod";

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
  /** Injectable for tests; defaults to the real remote D1 reader. */
  readerFactory?: (project: ProjectRecord, token: string) => StatsReader;
}

type Variables = { operator: string };

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cfAccountId: z.string().trim().min(1).max(64),
  d1DatabaseId: z.string().trim().min(1).max(64),
  token: z.string().trim().min(8).max(512),
});

const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  cfAccountId: z.string().trim().min(1).max(64).optional(),
  d1DatabaseId: z.string().trim().min(1).max(64).optional(),
  token: z.string().trim().min(8).max(512).optional(),
});

function defaultReaderFactory(project: ProjectRecord, token: string): StatsReader {
  return new RemoteD1Reader({
    accountId: project.cfAccountId,
    databaseId: project.d1DatabaseId,
    token,
  });
}

export function createApp(deps: AppDeps) {
  const readerFactory = deps.readerFactory ?? defaultReaderFactory;
  const app = new Hono<{ Variables: Variables }>();

  app.get("/health", (c) => c.json({ ok: true, service: "authfleet-api" }));

  // Operator identity gate for everything under /api.
  app.use("/api/*", async (c, next) => {
    const operator = c.req.header("x-authfleet-operator");
    if (operator) {
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
    const token = await decryptText(key, {
      ciphertext: project.tokenCiphertext,
      iv: project.tokenIv,
    });
    return readerFactory(project, token);
  }

  app.get("/api/projects", async (c) => {
    const records = await deps.repo.listProjects();
    const projects = records.map(toPublicProject);
    if (deps.demoEnabled) projects.unshift(toPublicProject(demoProject()));
    return c.json({ projects, operator: c.get("operator") });
  });

  app.post("/api/projects", async (c) => {
    const parsed = projectCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid project payload", issues: parsed.error.issues }, 400);
    }
    const key = await deps.getEncryptionKey();
    const encrypted = await encryptText(key, parsed.data.token);
    const record = await deps.repo.createProject({
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
      const encrypted = await encryptText(key, token);
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
      return c.json(
        { error: cause instanceof Error ? cause.message : "failed to read project stats" },
        502,
      );
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
      return c.json(
        { error: cause instanceof Error ? cause.message : "failed to snapshot project" },
        502,
      );
    }
  });

  return app;
}
