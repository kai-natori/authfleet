import { monotonicFactory } from "ulid";

/**
 * Row IDs are lowercase ULIDs: time-ordered (friendly to D1/SQLite
 * indexes) and lexicographically sortable. Secrets must NEVER use this —
 * see `generateRandomToken` in crypto.ts.
 *
 * The monotonic factory guarantees that ids minted within the same
 * millisecond still sort in creation order (the plain `ulid()` factory
 * randomises the tail, which made ordering tests flaky).
 */
const ulid = monotonicFactory();

export function newId(): string {
  return ulid().toLowerCase();
}
