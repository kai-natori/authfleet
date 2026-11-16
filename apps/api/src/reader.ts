import {
  decryptText,
  HttpAgentReader,
  type ProjectRecord,
  type ProjectStatsReader,
  projectTokenAad,
  RemoteD1Reader,
} from "@authfleet/core";

/**
 * Shared construction of a stats reader for a stored project: decrypt
 * the project's credential (AAD-bound to its registry row) and build
 * the reader for its connection type. Used by the HTTP app (app.ts)
 * and by the scheduled snapshot job (index.ts) so the
 * decrypt-and-build sequence exists exactly once.
 */

export async function decryptProjectCredential(
  key: CryptoKey,
  project: ProjectRecord,
): Promise<string> {
  return decryptText(
    key,
    { ciphertext: project.tokenCiphertext, iv: project.tokenIv },
    projectTokenAad(project.id),
  );
}

export function createProjectReader(
  project: ProjectRecord,
  credential: string,
): ProjectStatsReader {
  if (project.type === "agent") {
    if (!project.baseUrl) {
      throw new Error(`agent project ${project.id} has no baseUrl`);
    }
    return new HttpAgentReader({ baseUrl: project.baseUrl, apiKey: credential });
  }
  if (!project.cfAccountId || !project.d1DatabaseId) {
    throw new Error(`d1 project ${project.id} is missing its Cloudflare account/database id`);
  }
  return new RemoteD1Reader({
    accountId: project.cfAccountId,
    databaseId: project.d1DatabaseId,
    token: credential,
  });
}
