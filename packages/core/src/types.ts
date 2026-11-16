/**
 * How the dashboard reaches a project:
 * - `d1`: pull model — read the project's D1 via the Cloudflare HTTP
 *   query API with a per-project read-only Cloudflare token.
 * - `agent`: the AuthFleet plugin inside the target app serves counts
 *   over HTTP; the registry stores the app's base URL + the plugin
 *   API key.
 */
export type ProjectType = "d1" | "agent";

/**
 * A registered project as stored in the registry D1. The credential
 * (Cloudflare token for `d1`, plugin API key for `agent`) is
 * ciphertext only, in the same columns for both types — the AES-GCM +
 * AAD scheme is shared (see the agent-plugin design). Per-type fields
 * that do not apply are null.
 */
export interface ProjectRecord {
  id: string;
  type: ProjectType;
  name: string;
  /** `d1` only: Cloudflare account id. */
  cfAccountId: string | null;
  /** `d1` only: D1 database id. */
  d1DatabaseId: string | null;
  /** `agent` only: the target app's Better Auth base URL. */
  baseUrl: string | null;
  tokenCiphertext: string;
  tokenIv: string;
  /** Last 4 chars of the plaintext credential, for display only. */
  tokenHint: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PublicProjectBase {
  id: string;
  name: string;
  tokenHint: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project as exposed through the API — never includes credential
 * material, and omits the per-type fields that do not apply.
 */
export type PublicProject =
  | (PublicProjectBase & {
      type: "d1";
      cfAccountId: string;
      d1DatabaseId: string;
    })
  | (PublicProjectBase & {
      type: "agent";
      baseUrl: string;
    });

export function toPublicProject(record: ProjectRecord): PublicProject {
  const base: PublicProjectBase = {
    id: record.id,
    name: record.name,
    tokenHint: record.tokenHint,
    isDemo: record.isDemo,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.type === "agent") {
    return { ...base, type: "agent", baseUrl: record.baseUrl ?? "" };
  }
  return {
    ...base,
    type: "d1",
    cfAccountId: record.cfAccountId ?? "",
    d1DatabaseId: record.d1DatabaseId ?? "",
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
   * because the credential ciphertext is AAD-bound to it (see core
   * crypto). Repositories fall back to `newId()` when absent.
   */
  id?: string;
  type: ProjectType;
  name: string;
  cfAccountId: string | null;
  d1DatabaseId: string | null;
  baseUrl: string | null;
  tokenCiphertext: string;
  tokenIv: string;
  tokenHint: string;
  isDemo?: boolean;
}

export interface UpdateProjectData {
  name?: string;
  cfAccountId?: string | null;
  d1DatabaseId?: string | null;
  baseUrl?: string | null;
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
