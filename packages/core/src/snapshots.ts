import { AgentReadError } from "./agent-reader";
import { D1ReadError } from "./d1-reader";
import { dateString } from "./stats";
import type { ProjectRecord, ProjectRepository } from "./types";

export interface SnapshotJobDeps {
  repo: ProjectRepository;
  /** Build a stats reader for a project (token already decrypted). */
  readerFor: (project: ProjectRecord) => { getTotalUsers(): Promise<number> };
  now?: Date;
}

export interface SnapshotJobResult {
  projectId: string;
  projectName: string;
  ok: boolean;
  totalUsers?: number;
  error?: string;
}

/**
 * Record today's total user count for every non-demo project.
 * One project's failure never aborts the others.
 */
export async function runSnapshotJob(deps: SnapshotJobDeps): Promise<SnapshotJobResult[]> {
  const today = dateString(deps.now ?? new Date());
  const projects = await deps.repo.listProjects();
  const results: SnapshotJobResult[] = [];
  for (const project of projects) {
    if (project.isDemo) continue;
    try {
      const total = await deps.readerFor(project).getTotalUsers();
      await deps.repo.upsertSnapshot(project.id, today, total);
      results.push({
        projectId: project.id,
        projectName: project.name,
        ok: true,
        totalUsers: total,
      });
    } catch (cause) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        ok: false,
        // Server-side only (cron logs): include the upstream detail so
        // operators can diagnose; this string never reaches clients.
        error:
          (cause instanceof D1ReadError || cause instanceof AgentReadError) && cause.detail
            ? `${cause.message} ${cause.detail}`
            : cause instanceof Error
              ? cause.message
              : String(cause),
      });
    }
  }
  return results;
}
