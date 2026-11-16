import { newId } from "./ids";
import type {
  CreateProjectData,
  ProjectRecord,
  ProjectRepository,
  SnapshotRecord,
  UpdateProjectData,
} from "./types";

/** In-memory repository for tests and local demo wiring. */
export class InMemoryProjectRepository implements ProjectRepository {
  private projects = new Map<string, ProjectRecord>();
  private snapshots = new Map<string, SnapshotRecord>();

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    return this.projects.get(id) ?? null;
  }

  async createProject(data: CreateProjectData): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: data.id ?? newId(),
      type: data.type,
      name: data.name,
      cfAccountId: data.cfAccountId,
      d1DatabaseId: data.d1DatabaseId,
      baseUrl: data.baseUrl,
      tokenCiphertext: data.tokenCiphertext,
      tokenIv: data.tokenIv,
      tokenHint: data.tokenHint,
      isDemo: data.isDemo ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(record.id, record);
    return record;
  }

  async updateProject(id: string, data: UpdateProjectData): Promise<ProjectRecord | null> {
    const existing = this.projects.get(id);
    if (!existing) return null;
    const updated: ProjectRecord = {
      ...existing,
      ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      updatedAt: new Date().toISOString(),
    };
    this.projects.set(id, updated);
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.projects.delete(id);
  }

  async upsertSnapshot(
    projectId: string,
    date: string,
    totalUsers: number,
  ): Promise<SnapshotRecord> {
    const key = `${projectId}:${date}`;
    const existing = this.snapshots.get(key);
    if (existing) {
      const updated = { ...existing, totalUsers };
      this.snapshots.set(key, updated);
      return updated;
    }
    const record: SnapshotRecord = {
      id: newId(),
      projectId,
      date,
      totalUsers,
      createdAt: new Date().toISOString(),
    };
    this.snapshots.set(key, record);
    return record;
  }

  async listSnapshots(projectId: string, limit = 90): Promise<SnapshotRecord[]> {
    return [...this.snapshots.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit);
  }
}
