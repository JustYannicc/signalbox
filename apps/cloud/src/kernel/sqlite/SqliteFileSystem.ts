import type { PosixStorage } from "../PosixStorage.ts";
import type { ChangeGenerationStorage } from "../ChangeGenerationStorage.ts";
import { SqliteChunks } from "./SqliteChunks.ts";
import { SqliteInodes } from "./SqliteInodes.ts";
import { type FacetStorage, firstRow } from "./SqliteDatabase.ts";

import { SqliteHydration } from "./SqliteHydration.ts";
import { SqlitePosixMetadata } from "./SqlitePosixMetadata.ts";

export class PendingContentError extends Error {
  readonly code = "EAGAIN";
  readonly inode: bigint;
  constructor(inode: bigint) {
    super("File contents require hydration");
    this.inode = inode;
  }
}

/** One instance per harness facet incarnation, shared by the Node and WASI adapters. */
export function createSqliteFileSystem(storage: FacetStorage, nowNs: () => bigint) {
  const inodes = new SqliteInodes(storage, nowNs);
  const chunks = new SqliteChunks(inodes);
  const hydration = new SqliteHydration(storage);
  const ready = (inode: bigint) => {
    inodes.stat(inode);
    if (hydration.pending(inode)) throw new PendingContentError(inode);
  };
  const fs: PosixStorage & ChangeGenerationStorage = {
    posix: new SqlitePosixMetadata(inodes),
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
    readInto(inode, offset, target) {
      ready(inode);
      return chunks.readInto(inode, offset, target);
    },
    write(inode, offset, source) {
      ready(inode);
      return chunks.write(inode, offset, source);
    },
    append(inode, source) {
      ready(inode);
      return chunks.append(inode, source);
    },
    truncate(inode, size) {
      ready(inode);
      chunks.truncate(inode, size);
    },
    sync(inode) {
      // Every mutation has committed its transactionSync before returning. Drive checkpoints are separate.
      inodes.stat(inode);
    },
    changeGeneration() {
      // The facet has one connection, so this also counts hydration and revision writes that
      // bypass this object. Unrelated tables only cause a spurious rescan.
      const row = firstRow(storage.sql.exec("SELECT total_changes() AS changes"));
      // A constant fallback would make watchers miss every later change.
      if (row === undefined) throw new Error("SQLite returned no change count");
      return Number(row.changes);
    },
  };
  return { storage: fs, hydration };
}
