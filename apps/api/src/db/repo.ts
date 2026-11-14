import {
  type CreateProjectData,
  newId,
  type ProjectRecord,
  type ProjectRepository,
  type SnapshotRecord,
  type UpdateProjectData,
} from "@authfleet/core";
import { and, asc, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./schema";
import { projects, snapshots } from "./schema";

type DB = DrizzleD1Database<typeof schema>;

function toProjectRecord(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    cfAccountId: row.cfAccountId,
    d1DatabaseId: row.d1DatabaseId,
    tokenCiphertext: row.tokenCiphertext,
    tokenIv: row.tokenIv,
    tokenHint: row.tokenHint,
    isDemo: row.isDemo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSnapshotRecord(row: typeof snapshots.$inferSelect): SnapshotRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    date: row.date,
    totalUsers: row.totalUsers,
    createdAt: row.createdAt,
  };
}

/** Drizzle-backed registry repository (production). */
export class DrizzleProjectRepository implements ProjectRepository {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const rows = await this.db.select().from(projects).orderBy(asc(projects.createdAt));
    return rows.map(toProjectRecord);
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ? toProjectRecord(rows[0]) : null;
  }

  async createProject(data: CreateProjectData): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const row = {
      id: data.id ?? newId(),
      name: data.name,
      cfAccountId: data.cfAccountId,
      d1DatabaseId: data.d1DatabaseId,
      tokenCiphertext: data.tokenCiphertext,
      tokenIv: data.tokenIv,
      tokenHint: data.tokenHint,
      isDemo: data.isDemo ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(projects).values(row);
    return row;
  }

  async updateProject(id: string, data: UpdateProjectData): Promise<ProjectRecord | null> {
    const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.cfAccountId !== undefined) patch.cfAccountId = data.cfAccountId;
    if (data.d1DatabaseId !== undefined) patch.d1DatabaseId = data.d1DatabaseId;
    if (data.tokenCiphertext !== undefined) patch.tokenCiphertext = data.tokenCiphertext;
    if (data.tokenIv !== undefined) patch.tokenIv = data.tokenIv;
    if (data.tokenHint !== undefined) patch.tokenHint = data.tokenHint;
    await this.db.update(projects).set(patch).where(eq(projects.id, id));
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    const existing = await this.getProject(id);
    if (!existing) return false;
    await this.db.delete(snapshots).where(eq(snapshots.projectId, id));
    await this.db.delete(projects).where(eq(projects.id, id));
    return true;
  }

  async upsertSnapshot(
    projectId: string,
    date: string,
    totalUsers: number,
  ): Promise<SnapshotRecord> {
    const row = {
      id: newId(),
      projectId,
      date,
      totalUsers,
      createdAt: new Date().toISOString(),
    };
    await this.db
      .insert(snapshots)
      .values(row)
      .onConflictDoUpdate({
        target: [snapshots.projectId, snapshots.date],
        set: { totalUsers },
      });
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.projectId, projectId), eq(snapshots.date, date)))
      .limit(1);
    return rows[0] ? toSnapshotRecord(rows[0]) : row;
  }

  async listSnapshots(projectId: string, limit = 90): Promise<SnapshotRecord[]> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.projectId, projectId))
      .orderBy(desc(snapshots.date))
      .limit(limit);
    return rows.map(toSnapshotRecord).sort((a, b) => a.date.localeCompare(b.date));
  }
}
