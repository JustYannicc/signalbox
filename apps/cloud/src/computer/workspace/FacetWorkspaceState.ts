import type {
  ChangedInode,
  CommitInode,
  FilePersistenceResult,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import type { PosixMetadata } from "../../kernel/PosixStorage.ts";
import type { Inode, Stat } from "../../kernel/storage.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";

export type Persistence = ReturnType<typeof createFacetFilePersistence>;

export type EncodedStat = Omit<Stat, "size" | "nlink" | "atimeNs" | "mtimeNs" | "ctimeNs"> & {
  readonly size: string;
  readonly nlink: string;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};

export interface TreeEntry {
  readonly inode: string;
  readonly paths: readonly string[];
  readonly stat: EncodedStat;
  readonly symlinkTarget: string | null;
  readonly posix: PosixMetadata | null;
}

export interface WorkspaceState {
  readonly at: ForkCommit;
  readonly manifest: Map<string, TreeEntry>;
  readonly epoch: number;
}

export interface DirtyInode {
  readonly inode: string;
  readonly version: number;
}

export interface CheckpointAttempt {
  readonly at: ForkCommit;
  readonly manifest: string;
  readonly epoch: number;
  readonly changed: readonly ChangedInode[];
  readonly dirty: readonly DirtyInode[];
}

export interface ApplyPlan {
  readonly changed: CommitInode;
  localInode?: Inode;
  readonly sourcePaths: readonly string[];
}

export const firstRow = (rows: Iterable<Record<string, unknown>>) =>
  rows[Symbol.iterator]().next().value;

export const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : undefined;

export const cloneAt = (at: ForkCommit): ForkCommit => ({ ...at });

export const encodeStat = (stat: Stat): EncodedStat => ({
  ...stat,
  size: stat.size.toString(),
  nlink: stat.nlink.toString(),
  atimeNs: stat.atimeNs.toString(),
  mtimeNs: stat.mtimeNs.toString(),
  ctimeNs: stat.ctimeNs.toString(),
});

export const decodeStat = (stat: EncodedStat): Stat => ({
  ...stat,
  size: BigInt(stat.size),
  nlink: BigInt(stat.nlink),
  atimeNs: BigInt(stat.atimeNs),
  mtimeNs: BigInt(stat.mtimeNs),
  ctimeNs: BigInt(stat.ctimeNs),
});

export const encodeManifest = (manifest: ReadonlyMap<string, TreeEntry>) =>
  JSON.stringify(
    [...manifest.values()].sort((left, right) => left.inode.localeCompare(right.inode)),
  );

export class FacetWorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FacetWorkspaceError";
    this.code = code;
  }
}

export function installWorkspaceJournal(database: FacetStorage): void {
  database.transactionSync(() => {
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), repository TEXT NOT NULL, fork_name TEXT NOT NULL, commit_id TEXT NOT NULL, manifest_json TEXT NOT NULL, epoch INTEGER NOT NULL, baseline_epoch INTEGER NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_dirty_inode (ino TEXT PRIMARY KEY, version INTEGER NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_checkpoint (operation_id TEXT PRIMARY KEY, repository TEXT NOT NULL, fork_name TEXT NOT NULL, base_commit TEXT NOT NULL, commit_id TEXT NOT NULL, epoch INTEGER NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_attempt (operation_id TEXT PRIMARY KEY, repository TEXT NOT NULL, fork_name TEXT NOT NULL, base_commit TEXT NOT NULL, manifest_json TEXT NOT NULL, epoch INTEGER NOT NULL, changed_json TEXT NOT NULL, dirty_json TEXT NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_apply_chunk (apply_id TEXT NOT NULL, remote_ino TEXT NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, PRIMARY KEY (apply_id, remote_ino, part))",
    );
    // Storage exposes no mutation feed, so these triggers mark API writes for the apply-time CAS.
    const mark = (value: string) =>
      `INSERT INTO kernel_fs_workspace_dirty_inode (ino, version) VALUES (${value}, 1) ON CONFLICT(ino) DO UPDATE SET version = version + 1;`;
    const bump = "UPDATE kernel_fs_workspace_state SET epoch = epoch + 1 WHERE singleton = 1;";
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_inode_insert AFTER INSERT ON kernel_fs_inode BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_inode_update AFTER UPDATE ON kernel_fs_inode BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_inode_delete AFTER DELETE ON kernel_fs_inode BEGIN ${mark("OLD.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_entry_insert AFTER INSERT ON kernel_fs_entry BEGIN ${mark("NEW.ino")} ${mark("NEW.parent")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_entry_delete AFTER DELETE ON kernel_fs_entry BEGIN ${mark("OLD.ino")} ${mark("OLD.parent")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_posix_insert AFTER INSERT ON kernel_fs_posix BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_posix_update AFTER UPDATE ON kernel_fs_posix BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_posix_delete AFTER DELETE ON kernel_fs_posix BEGIN ${mark("OLD.ino")} ${bump} END`,
    );
  });
}

export function readState(database: FacetStorage): WorkspaceState {
  const row = firstRow(
    database.sql.exec(
      "SELECT repository, fork_name, commit_id, manifest_json, baseline_epoch FROM kernel_fs_workspace_state WHERE singleton = 1",
    ),
  );
  if (!row) throw new FacetWorkspaceError("EIO", "The facet workspace revision is missing");
  return {
    at: {
      repository: String(row.repository),
      fork: String(row.fork_name),
      commit: String(row.commit_id),
    },
    manifest: decodeManifest(String(row.manifest_json)),
    epoch: Number(row.baseline_epoch),
  };
}

export function readEpoch(database: FacetStorage): number {
  const row = firstRow(
    database.sql.exec("SELECT epoch FROM kernel_fs_workspace_state WHERE singleton = 1"),
  );
  if (!row) throw new FacetWorkspaceError("EIO", "The facet workspace revision is missing");
  return Number(row.epoch);
}

export function readDirty(database: FacetStorage): DirtyInode[] {
  return Array.from(
    database.sql.exec("SELECT ino, version FROM kernel_fs_workspace_dirty_inode ORDER BY ino"),
    (row) => ({
      inode: String(row.ino),
      version: Number(row.version),
    }),
  );
}

export function readAttempt(
  database: FacetStorage,
  operationId: string,
): CheckpointAttempt | undefined {
  const row = firstRow(
    database.sql.exec(
      "SELECT * FROM kernel_fs_workspace_attempt WHERE operation_id = ?",
      operationId,
    ),
  );
  if (!row) return undefined;
  const changedRaw = JSON.parse(String(row.changed_json)) as {
    inode: string;
    paths: string[];
    removedPaths: string[];
  }[];
  const dirty = JSON.parse(String(row.dirty_json)) as DirtyInode[];
  return {
    at: {
      repository: String(row.repository),
      fork: String(row.fork_name),
      commit: String(row.base_commit),
    },
    manifest: String(row.manifest_json),
    epoch: Number(row.epoch),
    changed: changedRaw.map((entry) => ({
      inode: BigInt(entry.inode) as Inode,
      paths: entry.paths,
      removedPaths: entry.removedPaths,
    })),
    dirty,
  };
}

export function encodeChanged(changed: ChangedInode) {
  return {
    inode: changed.inode.toString(),
    paths: [...changed.paths],
    removedPaths: [...changed.removedPaths],
  };
}

export function decodeManifest(json: string): Map<string, TreeEntry> {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    throw new FacetWorkspaceError("EIO", "The facet workspace manifest is invalid");
  }
  if (!Array.isArray(entries))
    throw new FacetWorkspaceError("EIO", "The facet workspace manifest is invalid");
  const result = new Map<string, TreeEntry>();
  for (const item of entries) {
    if (typeof item !== "object" || item === null)
      throw new FacetWorkspaceError("EIO", "The facet workspace manifest is invalid");
    const candidate = item as TreeEntry;
    if (
      !/^[1-9][0-9]*$/.test(candidate.inode) ||
      !Array.isArray(candidate.paths) ||
      !candidate.paths.every((path) => typeof path === "string") ||
      typeof candidate.stat !== "object" ||
      candidate.stat === null
    ) {
      throw new FacetWorkspaceError("EIO", "The facet workspace manifest is invalid");
    }
    result.set(candidate.inode, { ...candidate, paths: [...candidate.paths] });
  }
  return result;
}

export function scanTree(storage: Persistence["storage"], root: Inode): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const visitedDirectories = new Set<Inode>();
  const visit = (inode: Inode, path: string, rootNode = false): void => {
    const stat = storage.stat(inode);
    const key = inode.toString();
    if (!rootNode) {
      const existing = entries.get(key);
      if (existing) {
        entries.set(key, { ...existing, paths: [...existing.paths, path].sort() });
      } else {
        let posix: PosixMetadata | null = null;
        try {
          posix = storage.posix.get(inode);
        } catch (error) {
          if (errorCode(error) !== "ENOTSUP") throw error;
        }
        entries.set(key, {
          inode: key,
          paths: [path],
          stat: encodeStat(stat),
          symlinkTarget: stat.type === "symlink" ? storage.readlink(inode) : null,
          posix,
        });
      }
    }
    if (stat.type !== "directory") return;
    if (visitedDirectories.has(inode))
      throw new FacetWorkspaceError("EIO", "The workspace has a directory cycle");
    visitedDirectories.add(inode);
    for (const child of storage.readdir(inode)) {
      const childPath = path === "/" ? `/${child.name}` : `${path}/${child.name}`;
      visit(child.inode, childPath);
    }
  };
  visit(root, "/", true);
  return entries;
}

export function diffTrees(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  dirty: ReadonlySet<string>,
): ChangedInode[] {
  const changed: ChangedInode[] = [];
  for (const inode of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(inode);
    const current = after.get(inode);
    if (old && current && !dirty.has(inode) && sameTreeEntry(old, current)) continue;
    changed.push({
      inode: BigInt(inode) as Inode,
      paths: current?.paths ?? [],
      removedPaths: old?.paths.filter((path) => !current?.paths.includes(path)) ?? [],
    });
  }
  return changed;
}

export function sameTreeEntry(left: TreeEntry, right: TreeEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function hydrateChangedFiles(
  changed: readonly ChangedInode[],
  storage: Persistence["storage"],
  persistence: Persistence,
  signal: AbortSignal,
) {
  for (const { inode } of changed) {
    let stat: Stat;
    try {
      stat = storage.stat(inode);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (stat.type !== "file") continue;
    signal.throwIfAborted();
    await persistence.runLeaf(() => storage.readInto(inode, 0n, new Uint8Array(0)), signal);
  }
}

export function sameCommit(left: ForkCommit, right: ForkCommit): boolean {
  return (
    left.repository === right.repository && left.fork === right.fork && left.commit === right.commit
  );
}

export function persistenceError<T>(
  result: Extract<FilePersistenceResult<T>, { status: "error" }>,
): FacetWorkspaceError {
  return new FacetWorkspaceError(result.error.code, result.error.message);
}

export function assertUnchanged(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new FacetWorkspaceError(
      "LIVE_FILESYSTEM_DIVERGED",
      "The live filesystem changed after the command checkpoint; VM output was kept unapplied",
    );
  }
}
