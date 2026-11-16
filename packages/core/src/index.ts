export {
  AgentReadError,
  type AgentReadErrorKind,
  HttpAgentReader,
  type HttpAgentReaderOptions,
  normalizeAgentBaseUrl,
  SUPPORTED_CONTRACT_VERSIONS,
} from "./agent-reader";
export {
  decryptText,
  type EncryptedValue,
  encryptText,
  generateRandomToken,
  importEncryptionKey,
  projectTokenAad,
  tokenHint,
} from "./crypto";
export {
  assertReadOnlyQuery,
  D1ReadError,
  RemoteD1Reader,
  type RemoteD1ReaderOptions,
} from "./d1-reader";
export {
  DEMO_DAYS,
  DEMO_PROJECT_ID,
  demoProject,
  demoSnapshots,
  demoStats,
} from "./demo";
export { newId } from "./ids";
export { InMemoryProjectRepository } from "./memory-repo";
export type { ProjectStatsReader } from "./reader";
export {
  runSnapshotJob,
  type SnapshotJobDeps,
  type SnapshotJobResult,
} from "./snapshots";
export {
  buildStatsSummary,
  dateString,
  growthFromSnapshots,
  type ProjectStatsSummary,
  type SnapshotGrowth,
  sumSignupWindow,
} from "./stats";
export {
  type CreateProjectData,
  type DailySignup,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectType,
  type PublicProject,
  type SnapshotRecord,
  toPublicProject,
  type UpdateProjectData,
  type UserStats,
} from "./types";
