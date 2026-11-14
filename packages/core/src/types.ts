/** A registered project as stored in the registry D1. Token is ciphertext only. */
export interface ProjectRecord {
  id: string;
  name: string;
  cfAccountId: string;
  d1DatabaseId: string;
  tokenCiphertext: string;
  tokenIv: string;
  /** Last 4 chars of the plaintext token, for display only. */
  tokenHint: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A project as exposed through the API — never includes token material. */
export interface PublicProject {
  id: string;
  name: string;
  cfAccountId: string;
  d1DatabaseId: string;
  tokenHint: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublicProject(record: ProjectRecord): PublicProject {
  return {
    id: record.id,
    name: record.name,
    cfAccountId: record.cfAccountId,
    d1DatabaseId: record.d1DatabaseId,
    tokenHint: record.tokenHint,
    isDemo: record.isDemo,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface DailySignup {
  /** YYYY-MM-DD (UTC) */
  date: string;
  count: number;
}

export interface UserStats {
  totalUsers: number;
  /** null when the target `user` table has no anonymous-flag column. */
  anonymousUsers: number | null;
  dailySignups: DailySignup[];
  /** ISO timestamp of when the stats were read. */
  asOf: string;
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  /** YYYY-MM-DD (UTC) */
  date: string;
  totalUsers: number;
  createdAt: string;
}

export interface CreateProjectData {
  /**
   * Optional caller-supplied row id. The api generates the id up front
   * because the token ciphertext is AAD-bound to it (see core crypto).
   * Repositories fall back to `newId()` when absent.
   */
  id?: string;
  name: string;
  cfAccountId: string;
  d1DatabaseId: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenHint: string;
  isDemo?: boolean;
}

export interface UpdateProjectData {
  name?: string;
  cfAccountId?: string;
  d1DatabaseId?: string;
  tokenCiphertext?: string;
  tokenIv?: string;
  tokenHint?: string;
}

/**
 * Storage contract for the registry. Implemented with Drizzle in
 * apps/api (production) and in-memory here (tests, demo).
 */
export interface ProjectRepository {
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | null>;
  createProject(data: CreateProjectData): Promise<ProjectRecord>;
  updateProject(id: string, data: UpdateProjectData): Promise<ProjectRecord | null>;
  deleteProject(id: string): Promise<boolean>;
  /** One row per (project, day): insert or overwrite the day's total. */
  upsertSnapshot(projectId: string, date: string, totalUsers: number): Promise<SnapshotRecord>;
  listSnapshots(projectId: string, limit?: number): Promise<SnapshotRecord[]>;
}
