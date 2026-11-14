import { ulid } from "ulid";

/**
 * Row IDs are lowercase ULIDs: time-ordered (friendly to D1/SQLite
 * indexes) and lexicographically sortable. Secrets must NEVER use this —
 * see `generateRandomToken` in crypto.ts.
 */
export function newId(): string {
  return ulid().toLowerCase();
}
