import { createSqliteFileSystem } from "./sqlite/SqliteFileSystem.ts";
import type { FacetStorage } from "./sqlite/SqliteDatabase.ts";

export type { FacetStorage } from "./sqlite/SqliteDatabase.ts";
export { FILE_CHUNK_BYTES } from "./sqlite/SqliteChunks.ts";

/** One instance per harness facet incarnation, shared by the Node and WASI adapters. */
export function createFacetSqliteStorage(storage: FacetStorage, nowNs: () => bigint) {
  return createSqliteFileSystem(storage, nowNs).storage;
}
