import { importEncryptionKey, runSnapshotJob } from "@authfleet/core";
import { drizzle } from "drizzle-orm/d1";
import { type AppDeps, createApp } from "./app";
import { ensureMigrations } from "./db/migrate";
import { DrizzleProjectRepository } from "./db/repo";
import * as schema from "./db/schema";
import { createProjectReader, decryptProjectCredential } from "./reader";

/**
 * Production wiring.
 *
 * Exposure model: this Worker has `workers_dev: false` and no routes in
 * wrangler.jsonc. It is reachable ONLY through the service binding from
 * the web Worker. See openspec design "Binding security model".
 */
export interface Env {
  DB: D1Database;
  /** Base64 32-byte AES-GCM key. Set with `wrangler secret put`. */
  TOKEN_ENCRYPTION_KEY: string;
  AUTHFLEET_DEMO?: string;
  /** Local dev only. Never set in production. */
  AUTHFLEET_DEV_BYPASS?: string;
  AUTHFLEET_DEV_OPERATOR?: string;
  /**
   * Comma-separated operator allowlist (audit F2). Set this in
   * production: required unless the explicit local dev bypass is enabled.
   */
  AUTHFLEET_OPERATOR_EMAILS?: string;
}

function buildDeps(env: Env): AppDeps {
  let keyPromise: Promise<CryptoKey> | null = null;
  const repo = new DrizzleProjectRepository(drizzle(env.DB, { schema }));
  const operatorEmails = env.AUTHFLEET_OPERATOR_EMAILS?.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return {
    ensureMigrations: () => ensureMigrations(env.DB),
    repo,
    getEncryptionKey: () => {
      if (!env.TOKEN_ENCRYPTION_KEY) {
        return Promise.reject(
          new Error("TOKEN_ENCRYPTION_KEY is not set (wrangler secret put TOKEN_ENCRYPTION_KEY)"),
        );
      }
      keyPromise ??= importEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
      return keyPromise;
    },
    demoEnabled: env.AUTHFLEET_DEMO === "1",
    devBypass: env.AUTHFLEET_DEV_BYPASS === "1",
    devOperator: env.AUTHFLEET_DEV_OPERATOR ?? "dev@local",
    operatorEmails,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = createApp(buildDeps(env));
    return app.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureMigrations(env.DB);
    const deps = buildDeps(env);
    const key = await deps.getEncryptionKey();
    const results = await runSnapshotJob({
      repo: deps.repo,
      readerFor: (project) => ({
        getTotalUsers: async () => {
          const credential = await decryptProjectCredential(key, project);
          const stats = await createProjectReader(project, credential).getUserStats(1);
          return stats.totalUsers;
        },
      }),
    });
    for (const result of results) {
      if (!result.ok) {
        console.error(`snapshot failed for ${result.projectName}: ${result.error}`);
      }
    }
    ctx.waitUntil(Promise.resolve());
  },
};
