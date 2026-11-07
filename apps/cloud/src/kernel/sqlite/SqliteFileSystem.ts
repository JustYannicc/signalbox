import type { PosixStorage } from "../PosixStorage.ts";
import type { ChangeGenerationStorage } from "../ChangeGenerationStorage.ts";
import type { KernelLowerFileSystemUpperStorage } from "../KernelLowerFileSystemUpperStorage.ts";
import type { SnapshotStorage } from "../KernelStorageSnapshot.ts";
import { SqliteChunks } from "./SqliteChunks.ts";
import { SqliteInodes } from "./SqliteInodes.ts";
import { type FacetStorage, firstRow } from "./SqliteDatabase.ts";

import { SqliteHydration } from "./SqliteHydration.ts";
import { SqlitePosixMetadata } from "./SqlitePosixMetadata.ts";
import { readSqliteSnapshot } from "./SqliteSnapshot.ts";

export class PendingContentError extends Error {
  readonly code = "EAGAIN";
  readonly inode: bigint;
  constructor(inode: bigint) {
    super("File contents require hydration");
    this.inode = inode;
  }
}

// Triggers see every writer of these tables, including revision apply's direct SQL, and nothing
// else on the connection. Chunk writes always update their inode row; hydration only fills
// bytes the inode already describes.
const changeTables = [
  ["kernel_fs_inode", ["ino"]],
  ["kernel_fs_entry", ["ino", "parent"]],
  ["kernel_fs_posix", ["ino"]],
] as const;

function installChangeFeed(storage: FacetStorage) {
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_generation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), value INTEGER NOT NULL, floor INTEGER NOT NULL)",
    );
    storage.sql.exec("INSERT OR IGNORE INTO kernel_fs_generation VALUES (1, 0, 0)");
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_change (ino TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS kernel_fs_change_generation ON kernel_fs_change (generation)",
    );
    for (const [table, columns] of changeTables)
      for (const [event, rows] of [
        ["insert", ["NEW"]],
        ["update", ["OLD", "NEW"]],
        ["delete", ["OLD"]],
      ] as const) {
        const marks = rows.flatMap((row) =>
          columns.map(
            (column) =>
              `INSERT INTO kernel_fs_change (ino, generation) SELECT ${row}.${column}, value FROM kernel_fs_generation WHERE singleton = 1 ON CONFLICT(ino) DO UPDATE SET generation = excluded.generation;`,
          ),
        );
        storage.sql.exec(
          `CREATE TRIGGER IF NOT EXISTS ${table}_change_${event} AFTER ${event.toUpperCase()} ON ${table} BEGIN UPDATE kernel_fs_generation SET value = value + 1 WHERE singleton = 1; ${marks.join(" ")} END`,
        );
      }
    // Overlay copy-up publishes a new inode under an existing name, so readers also need names.
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_change_name (parent TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY (parent, name))",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS kernel_fs_change_name_generation ON kernel_fs_change_name (generation)",
    );
    for (const [event, rows] of [
      ["insert", ["NEW"]],
      ["update", ["OLD", "NEW"]],
      ["delete", ["OLD"]],
    ] as const)
      storage.sql.exec(
        `CREATE TRIGGER IF NOT EXISTS kernel_fs_entry_name_${event} AFTER ${event.toUpperCase()} ON kernel_fs_entry BEGIN UPDATE kernel_fs_generation SET value = value + 1 WHERE singleton = 1; ${rows
          .map(
            (row) =>
              `INSERT INTO kernel_fs_change_name (parent, name, generation) SELECT ${row}.parent, ${row}.name, value FROM kernel_fs_generation WHERE singleton = 1 ON CONFLICT(parent, name) DO UPDATE SET generation = excluded.generation;`,
          )
          .join(" ")} END`,
      );
    // Feed readers live in one incarnation, so earlier rows can only answer bases nobody holds.
    storage.sql.exec("DELETE FROM kernel_fs_change");
    storage.sql.exec("DELETE FROM kernel_fs_change_name");
    storage.sql.exec("UPDATE kernel_fs_generation SET floor = value WHERE singleton = 1");
  });
}

/** One instance per harness facet incarnation, shared by the Node and WASI adapters. */
export function createSqliteFileSystem(storage: FacetStorage, nowNs: () => bigint) {
  const inodes = new SqliteInodes(storage, nowNs);
  installChangeFeed(storage);
  const generation = () => {
    const row = firstRow(
      storage.sql.exec("SELECT value, floor FROM kernel_fs_generation WHERE singleton = 1"),
    );
    // A constant fallback would make watchers miss every later change.
    if (row === undefined) throw new Error("Filesystem generation is missing");
    return { value: Number(row.value), floor: Number(row.floor) };
  };
  const chunks = new SqliteChunks(inodes);
  const hydration = new SqliteHydration(storage);
  const posix = new SqlitePosixMetadata(inodes);
  const ready = (inode: bigint) => {
    inodes.stat(inode);
    if (hydration.pending(inode)) throw new PendingContentError(inode);
  };
  const fs: PosixStorage &
    ChangeGenerationStorage &
    KernelLowerFileSystemUpperStorage &
    SnapshotStorage = {
    posix,
    snapshot: (maxEntries) => readSqliteSnapshot(storage, maxEntries),
    lowerOverlay: {
      isLowerPathHidden: inodes.isLowerPathHidden.bind(inodes),
      isStagingPath: inodes.isStagingPath.bind(inodes),
      createStagingFile: (parent, name, path, metadata) =>
        posix.createStagingFile(parent, name, path, metadata),
      publishStagingFile: (input) => inodes.publishStagingFile(input),
      discardStagingFile: (parent, name, path) => inodes.discardStagingFile(parent, name, path),
      renameFileWithWhiteout: (fromParent, fromName, toParent, toName, hiddenLowerPath) =>
        inodes.renameFileWithWhiteout(fromParent, fromName, toParent, toName, hiddenLowerPath),
      unlinkFileWithWhiteout: (parent, name, hiddenLowerPath) =>
        inodes.unlinkFileWithWhiteout(parent, name, hiddenLowerPath),
    },
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
    changeGeneration: () => generation().value,
    changesSince(since) {
      const current = generation();
      if (!Number.isSafeInteger(since) || since < current.floor || since > current.value)
        return undefined;
      return {
        inodes: Array.from(
          storage.sql.exec("SELECT ino FROM kernel_fs_change WHERE generation > ?", since),
          (row) => BigInt(String(row.ino)),
        ),
        names: Array.from(
          storage.sql.exec(
            "SELECT parent, name FROM kernel_fs_change_name WHERE generation > ?",
            since,
          ),
          (row) => ({ parent: BigInt(String(row.parent)), name: String(row.name) }),
        ),
      };
    },
  };
  return { storage: fs, hydration };
}
