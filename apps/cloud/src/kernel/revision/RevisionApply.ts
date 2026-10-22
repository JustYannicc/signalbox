import type { CommitInode, FileHydrationPort, ForkCommit } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import type { FacetStorage } from "../FacetSqliteStorage.ts";
import type { createFacetFilePersistence } from "../FacetFilePersistence.ts";
import type { ApplyPlan, DirtyInode, TreeEntry, WorkspaceState } from "./RevisionTypes.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";
import { readDirty, readEpoch, readState, restoreDirtySnapshot } from "./RevisionJournal.ts";
import { writeStateManifest } from "../KernelRevisionJournalStorage.ts";
import { applyChangesToManifest, encodeManifest, sameCommit, scanTree } from "./RevisionTree.ts";
import { assertNoRevisionConflict } from "./RevisionConflict.ts";
import { findRetiredInodes, resolveLocalInodes, validatePlans } from "./RevisionPlan.ts";
import { hydratePendingCandidates, stageFiles } from "./RevisionStaging.ts";
import { reconcileNamespace } from "./RevisionNamespace.ts";
import { assertNamespacePathsOwned } from "./RevisionNamespaceOwnership.ts";
import {
  localContentChanged,
  mergePosixMetadata,
  mergeRevisionStat,
  remoteContentChanged,
} from "./RevisionMetadata.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";

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
  readonly applyId: string;
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
    applyId,
    signal,
  } = input;
  const storage = persistence.storage;
  try {
    const plans = validatePlans(changedInodes);
    assertNamespacePathsOwned(
      filesystem,
      mountPath,
      storage,
      plans.flatMap((plan) => [...plan.changed.paths, ...plan.changed.removedPaths]),
    );
    assertNoRevisionConflict(
      baseline.manifest,
      scanTree(storage, rootInode),
      readDirty(database),
      changedInodes,
    );
    await stageFiles(database, hydration, after, applyId, plans, signal);
    signal.throwIfAborted();
    const stagedTree = scanTree(storage, rootInode);
    const stagedDirty = readDirty(database);
    assertNoRevisionConflict(baseline.manifest, stagedTree, stagedDirty, changedInodes);
    const retired = findRetiredInodes(baseline.manifest, stagedTree, plans);
    const resolved = resolveLocalInodes(baseline.manifest, stagedTree, plans, retired, storage);
    await hydratePendingCandidates(storage, persistence, resolved, signal);
    signal.throwIfAborted();
    const hydratedTree = scanTree(storage, rootInode);
    assertNoRevisionConflict(baseline.manifest, hydratedTree, readDirty(database), changedInodes);
    database.transactionSync(() => {
      const latest = readState(database);
      if (!sameCommit(latest.at, before))
        throw new KernelRevisionWorkspaceError(
          "ESTALE",
          "The live workspace revision changed during apply",
        );
      const current = scanTree(storage, rootInode);
      const dirtyBeforeApply = readDirty(database);
      assertNoRevisionConflict(baseline.manifest, current, dirtyBeforeApply, changedInodes);
      const currentRetired = findRetiredInodes(baseline.manifest, current, plans);
      const currentPlans = resolveLocalInodes(
        baseline.manifest,
        current,
        plans,
        currentRetired,
        storage,
      );
      const reconciled = reconcileNamespace(
        filesystem,
        mountPath,
        rootRealPath,
        storage,
        applyId,
        currentPlans,
      );
      applyMetadataAndChunks(
        database,
        storage,
        baseline.manifest,
        current,
        reconciled,
        dirtyBeforeApply,
        applyId,
      );
      // Local metadata stays dirty; the manifest must describe the remote revision.
      const manifest = applyChangesToManifest(baseline.manifest, reconciled);
      database.sql.exec(
        "UPDATE kernel_fs_workspace_state SET commit_id = ?, manifest_json = ?, baseline_epoch = ? WHERE singleton = 1",
        after.commit,
        writeStateManifest(database, encodeManifest(manifest)),
        readEpoch(database),
      );
      restoreDirtySnapshot(database, dirtyBeforeApply);
    });
  } finally {
    database.sql.exec("DELETE FROM kernel_fs_workspace_apply_chunk WHERE apply_id = ?", applyId);
  }
}

function applyMetadataAndChunks(
  database: FacetStorage,
  storage: ReturnType<typeof createFacetFilePersistence>["storage"],
  baseline: ReadonlyMap<string, TreeEntry>,
  current: ReadonlyMap<string, TreeEntry>,
  plans: readonly ApplyPlan[],
  dirty: readonly DirtyInode[],
  applyId: string,
): void {
  const dirtyInodes = new Set(dirty.map((entry) => entry.inode));
  for (const plan of plans) {
    if (!plan.changed.stat) continue;
    const localInode = plan.localInode;
    if (localInode === undefined)
      throw new KernelRevisionWorkspaceError("EIO", "The applied inode has no live identity");
    const key = localInode.toString();
    const old = baseline.get(key);
    const local = current.get(key);
    const stat = mergeRevisionStat(plan.changed, old, local, storage.stat(localInode));
    const posix = mergePosixMetadata(old?.posix ?? null, local?.posix ?? null, plan.changed.posix);
    // A coarse filesystem clock can hide a same-size write from stat comparisons.
    const preserveLocalContent =
      old !== undefined &&
      local !== undefined &&
      !remoteContentChanged(old, plan.changed) &&
      (localContentChanged(old, local) || dirtyInodes.has(key));
    const symlinkTarget = preserveLocalContent
      ? (local?.symlinkTarget ?? plan.changed.symlinkTarget)
      : plan.changed.symlinkTarget;
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
        stat.type === "symlink" ? symlinkTarget : null,
        localInode.toString(),
      );
      if (posix === null)
        database.sql.exec("DELETE FROM kernel_fs_posix WHERE ino = ?", localInode.toString());
      else
        database.sql.exec(
          "INSERT INTO kernel_fs_posix (ino, mode, uid, gid) VALUES (?, ?, ?, ?) ON CONFLICT(ino) DO UPDATE SET mode = excluded.mode, uid = excluded.uid, gid = excluded.gid",
          localInode.toString(),
          posix.mode,
          posix.uid,
          posix.gid,
        );
      if (stat.type !== "file" || !remoteContentChanged(old, plan.changed)) return;
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
