import type { Storage } from "./storage.ts";
import { SqliteChunks } from "./sqlite/SqliteChunks.ts";
import { SqliteInodes } from "./sqlite/SqliteInodes.ts";
import type { FacetStorage } from "./sqlite/SqliteDatabase.ts";

export type { FacetStorage } from "./sqlite/SqliteDatabase.ts";
export { FILE_CHUNK_BYTES } from "./sqlite/SqliteChunks.ts";

/** One instance per harness facet incarnation, shared by the Node and WASI adapters. */
export function createFacetSqliteStorage(storage: FacetStorage, nowNs: () => bigint): Storage {
  const inodes = new SqliteInodes(storage, nowNs);
  const chunks = new SqliteChunks(inodes);
  return {
    root: inodes.root,
    lookup: inodes.lookup.bind(inodes),
    stat: inodes.stat.bind(inodes),
    readlink: inodes.readlink.bind(inodes),
    readdir: inodes.readdir.bind(inodes),
    retain: inodes.retain.bind(inodes),
    release: inodes.release.bind(inodes),
    create: inodes.create.bind(inodes),
    link: inodes.link.bind(inodes),
    unlink: inodes.unlink.bind(inodes),
    rename: inodes.rename.bind(inodes),
    setTimes: inodes.setTimes.bind(inodes),
    readInto: chunks.readInto.bind(chunks),
    write: chunks.write.bind(chunks),
    append: chunks.append.bind(chunks),
    truncate: chunks.truncate.bind(chunks),
    sync(inode) {
      // Every mutation has committed its transactionSync before returning. Drive checkpoints are separate.
      inodes.stat(inode);
    },
  };
}
