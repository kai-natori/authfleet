import { decryptText, type ProjectRecord, projectTokenAad, RemoteD1Reader } from "@authfleet/core";

/**
 * Shared construction of a stats reader for a stored project: decrypt
 * the project's Cloudflare token (AAD-bound to its registry row) and
 * build the remote D1 reader. Used by the HTTP app (app.ts) and by the
 * scheduled snapshot job (index.ts) so the decrypt-and-build sequence
 * exists exactly once.
 */

export async function decryptProjectToken(key: CryptoKey, project: ProjectRecord): Promise<string> {
  return decryptText(
    key,
    { ciphertext: project.tokenCiphertext, iv: project.tokenIv },
    projectTokenAad(project.id),
  );
}

export function createProjectReader(project: ProjectRecord, token: string): RemoteD1Reader {
  return new RemoteD1Reader({
    accountId: project.cfAccountId,
    databaseId: project.d1DatabaseId,
    token,
  });
}
