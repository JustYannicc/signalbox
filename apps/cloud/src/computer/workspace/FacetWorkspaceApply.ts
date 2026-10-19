import type {
  CommitInode,
  FileHydrationPort,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import { isPosixMetadata } from "../../kernel/PosixStorage.ts";
import type { Inode } from "../../kernel/storage.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import type { ApplyPlan, Persistence, TreeEntry, WorkspaceState } from "./FacetWorkspaceState.ts";
import {
  assertUnchanged,
  encodeManifest,
  FacetWorkspaceError,
  persistenceError,
  readEpoch,
  readState,
  sameCommit,
  scanTree,
} from "./FacetWorkspaceState.ts";
import { reconcileNamespace } from "./FacetWorkspaceNamespace.ts";
import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";

export async function applyRevision(input: {
  readonly database: FacetStorage;
  readonly filesystem: KernelFileSystem;
  readonly persistence: ReturnType<typeof createFacetFilePersistence>;
  readonly mountPath: string;
  readonly rootRealPath: string;
  readonly rootInode: Inode;
  readonly before: ForkCommit;
  readonly after: ForkCommit;
  readonly changedInodes: readonly CommitInode[];
  readonly hydration: FileHydrationPort;
  readonly baseline: WorkspaceState;
  readonly signal: AbortSignal;
}): Promise<void> {
  const {
    database,
    filesystem,
    persistence,
    mountPath,
    rootRealPath,
    rootInode,
    before,
    after,
    changedInodes,
    hydration,
    baseline,
    signal,
  } = input;
  const applyId = `${before.repository}:${before.fork}:${before.commit}->${after.commit}`;
  const storage = persistence.storage;
  try {
    assertUnchanged(baseline.epoch, readEpoch(database));
    const plans = validatePlans(changedInodes);
    await stageFiles(database, hydration, after, applyId, plans, signal);
    const current = scanTree(storage, rootInode);
    assertUnchanged(baseline.epoch, readEpoch(database));
    const retired = findRetiredInodes(baseline.manifest, current, plans);
    const resolved = resolveLocalInodes(baseline.manifest, current, plans, retired, storage);
    await hydratePendingCandidates(storage, persistence, resolved, signal);
    signal.throwIfAborted();
    database.transactionSync(() => {
      const latest = readState(database);
      if (!sameCommit(latest.at, before))
        throw new FacetWorkspaceError("ESTALE", "The live workspace revision changed during apply");
      assertUnchanged(baseline.epoch, readEpoch(database));
      const reconciled = reconcileNamespace(filesystem, mountPath, rootRealPath, applyId, resolved);
      applyMetadataAndChunks(database, reconciled, applyId);
      const manifest = scanTree(storage, rootInode);
      database.sql.exec(
        "UPDATE kernel_fs_workspace_state SET commit_id = ?, manifest_json = ?, baseline_epoch = ? WHERE singleton = 1",
        after.commit,
        encodeManifest(manifest),
        readEpoch(database),
      );
      database.sql.exec("DELETE FROM kernel_fs_workspace_dirty_inode");
    });
  } finally {
    database.sql.exec("DELETE FROM kernel_fs_workspace_apply_chunk WHERE apply_id = ?", applyId);
  }
}

export function validateWorkspacePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path === "/" ||
    path
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new FacetWorkspaceError(
      "EINVAL",
      "The persistence port returned a path outside the revision root",
    );
  }
}

export function validatePlans(changed: readonly CommitInode[]): ApplyPlan[] {
  const seenInodes = new Set<string>();
  const desiredPaths = new Set<string>();
  return changed.map((entry) => {
    const remoteInode = entry.inode.toString();
    if (seenInodes.has(remoteInode))
      throw new FacetWorkspaceError("EINVAL", "The VM returned a duplicate changed inode");
    seenInodes.add(remoteInode);
    for (const path of [...entry.paths, ...entry.removedPaths]) validateWorkspacePath(path);
    if (entry.stat) {
      if (entry.stat.size < 0n || entry.stat.nlink < 0n)
        throw new FacetWorkspaceError("EINVAL", "The VM returned invalid inode metadata");
      if (entry.paths.length === 0)
        throw new FacetWorkspaceError("EINVAL", "A live inode needs at least one path");
      if (entry.stat.type === "symlink" && entry.symlinkTarget === null)
        throw new FacetWorkspaceError("EINVAL", "A symlink needs a target");
      if (entry.stat.nlink > BigInt(Number.MAX_SAFE_INTEGER))
        throw new FacetWorkspaceError("EOVERFLOW", "The VM returned an unsupported link count");
      if (entry.stat.type === "directory" && entry.paths.length !== 1)
        throw new FacetWorkspaceError("EPERM", "Directories cannot have hard links");
      if (entry.stat.type === "symlink" && entry.symlinkTarget !== null) {
        if (
          entry.symlinkTarget.includes("\0") ||
          BigInt(new TextEncoder().encode(entry.symlinkTarget).byteLength) !== entry.stat.size
        ) {
          throw new FacetWorkspaceError("EINVAL", "The VM returned invalid symlink metadata");
        }
      }
      if (entry.posix != null && !isPosixMetadata(entry.posix))
        throw new FacetWorkspaceError("EINVAL", "The VM returned invalid POSIX metadata");
    }
    for (const path of entry.paths) {
      if (desiredPaths.has(path))
        throw new FacetWorkspaceError("EINVAL", "The VM returned more than one inode for a path");
      desiredPaths.add(path);
    }
    return { changed: entry, sourcePaths: [] };
  });
}

export async function stageFiles(
  database: FacetStorage,
  hydration: FileHydrationPort,
  after: ForkCommit,
  applyId: string,
  plans: readonly ApplyPlan[],
  signal: AbortSignal,
): Promise<void> {
  const files = plans.filter((plan) => plan.changed.stat?.type === "file");
  const paths = files.map((plan) => plan.changed.paths[0]!);
  if (paths.length === 0) return;
  database.sql.exec("DELETE FROM kernel_fs_workspace_apply_chunk WHERE apply_id = ?", applyId);
  const result = await hydration.fetch({ at: after, paths, signal });
  if (result.status === "error") throw persistenceError(result);
  if (result.value.length !== paths.length)
    throw new FacetWorkspaceError("IO_ERROR", "Hydration did not return every changed file");
  const byPath = new Map(files.map((plan) => [plan.changed.paths[0]!, plan.changed]));
  const seen = new Set<string>();
  for (const file of result.value) {
    const entry = byPath.get(file.path);
    if (!entry || seen.has(file.path))
      throw new FacetWorkspaceError("IO_ERROR", "Hydration returned an unexpected changed path");
    seen.add(file.path);
    let received = 0n;
    let part = 0;
    for await (const chunk of file.chunks) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array))
        throw new FacetWorkspaceError("IO_ERROR", "Hydration returned a non-byte chunk");
      received += BigInt(chunk.byteLength);
      if (received > entry.stat!.size)
        throw new FacetWorkspaceError("IO_ERROR", "Hydration exceeded the declared file size");
      for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
        const blob = chunk.subarray(offset, Math.min(offset + 64 * 1024, chunk.byteLength)).slice()
          .buffer as ArrayBuffer;
        database.sql.exec(
          "INSERT INTO kernel_fs_workspace_apply_chunk VALUES (?, ?, ?, ?)",
          applyId,
          entry.inode.toString(),
          part++,
          blob,
        );
      }
    }
    if (received !== entry.stat!.size)
      throw new FacetWorkspaceError("IO_ERROR", "Hydration did not match the declared file size");
  }
}

export function findRetiredInodes(
  before: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  plans: readonly ApplyPlan[],
): Set<string> {
  const retired = new Set<string>();
  const paths = new Set(
    plans.filter((plan) => plan.changed.stat === null).flatMap((plan) => plan.changed.removedPaths),
  );
  for (const [inode, entry] of before)
    if (entry.paths.some((path) => paths.has(path))) retired.add(inode);
  for (const [inode, entry] of current)
    if (entry.paths.some((path) => paths.has(path))) retired.add(inode);
  return retired;
}

export function resolveLocalInodes(
  before: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  plans: readonly ApplyPlan[],
  retired: ReadonlySet<string>,
  storage: Persistence["storage"],
): ApplyPlan[] {
  const used = new Set<string>();
  const byPath = (tree: ReadonlyMap<string, TreeEntry>) =>
    new Map(
      [...tree.values()].flatMap((entry) => entry.paths.map((path) => [path, entry] as const)),
    );
  const oldPaths = byPath(before);
  const livePaths = byPath(current);
  return plans.map((plan) => {
    if (!plan.changed.stat) return plan;
    const candidates = [
      ...plan.changed.removedPaths.map((path) => oldPaths.get(path) ?? livePaths.get(path)),
      ...plan.changed.paths.map((path) => livePaths.get(path) ?? oldPaths.get(path)),
    ].filter((entry): entry is TreeEntry => entry !== undefined);
    const candidate = candidates.find((entry) => {
      if (retired.has(entry.inode) || used.has(entry.inode)) return false;
      try {
        return storage.stat(BigInt(entry.inode) as Inode).type === plan.changed.stat!.type;
      } catch {
        return false;
      }
    });
    if (!candidate) return plan;
    used.add(candidate.inode);
    const sourcePaths = [
      ...new Set([
        ...(before.get(candidate.inode)?.paths ?? []),
        ...(current.get(candidate.inode)?.paths ?? []),
      ]),
    ];
    return { ...plan, localInode: BigInt(candidate.inode) as Inode, sourcePaths };
  });
}

export async function hydratePendingCandidates(
  storage: Persistence["storage"],
  persistence: Persistence,
  plans: readonly ApplyPlan[],
  signal: AbortSignal,
): Promise<void> {
  const seen = new Set<Inode>();
  for (const plan of plans) {
    if (
      plan.changed.stat?.type !== "file" ||
      plan.localInode === undefined ||
      seen.has(plan.localInode)
    )
      continue;
    seen.add(plan.localInode);
    signal.throwIfAborted();
    await persistence.runLeaf(
      () => storage.readInto(plan.localInode!, 0n, new Uint8Array(0)),
      signal,
    );
  }
}

export function applyMetadataAndChunks(
  database: FacetStorage,
  plans: readonly ApplyPlan[],
  applyId: string,
): void {
  for (const plan of plans) {
    if (!plan.changed.stat) continue;
    const localInode = plan.localInode;
    if (localInode === undefined)
      throw new FacetWorkspaceError("EIO", "The applied inode has no live identity");
    const stat = plan.changed.stat;
    database.transactionSync(() => {
      // Descriptors point at the local inode number, so replace its rows instead of swapping in a copy.
      database.sql.exec(
        "UPDATE kernel_fs_inode SET type = ?, size = ?, nlink = ?, atime_ns = ?, mtime_ns = ?, ctime_ns = ?, target = ? WHERE ino = ?",
        stat.type,
        stat.size.toString(),
        Number(stat.nlink),
        stat.atimeNs.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString(),
        stat.type === "symlink" ? plan.changed.symlinkTarget : null,
        localInode.toString(),
      );
      if (plan.changed.posix === null)
        database.sql.exec("DELETE FROM kernel_fs_posix WHERE ino = ?", localInode.toString());
      else if (plan.changed.posix !== undefined)
        database.sql.exec(
          "INSERT INTO kernel_fs_posix (ino, mode, uid, gid) VALUES (?, ?, ?, ?) ON CONFLICT(ino) DO UPDATE SET mode = excluded.mode, uid = excluded.uid, gid = excluded.gid",
          localInode.toString(),
          plan.changed.posix.mode,
          plan.changed.posix.uid,
          plan.changed.posix.gid,
        );
      if (stat.type !== "file") return;
      database.sql.exec("DELETE FROM kernel_fs_chunk WHERE ino = ?", localInode.toString());
      database.sql.exec(
        "INSERT INTO kernel_fs_chunk (ino, part, bin) SELECT ?, part, bin FROM kernel_fs_workspace_apply_chunk WHERE apply_id = ? AND remote_ino = ?",
        localInode.toString(),
        applyId,
        plan.changed.inode.toString(),
      );
      database.sql.exec("DELETE FROM kernel_fs_origin WHERE ino = ?", localInode.toString());
      database.sql.exec(
        "DELETE FROM kernel_fs_hydration_chunk WHERE ino = ?",
        localInode.toString(),
      );
    });
  }
}
