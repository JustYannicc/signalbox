import type { CommitInode, FileHydrationPort, ForkCommit } from "./FilePersistencePorts.ts";
import type { FacetStorage } from "./FacetSqliteStorage.ts";
import type { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { kernelFileByteViewStorage } from "./KernelLowerFileSystemStorage.ts";
import { applyRevision } from "./revision/RevisionApply.ts";
import { KernelRevisionWorkspaceError, persistenceError } from "./revision/RevisionErrors.ts";
import {
  deleteStaleAttempt,
  ensureWorkspaceState,
  hasWorkspaceState,
  insertCheckpointAttempt,
  installWorkspaceJournal,
  readAttempt,
  readDirty,
  readEpoch,
  readState,
  recordCheckpoint,
  checkpointReceiptWithBase,
} from "./revision/RevisionJournal.ts";
import { normalizeMountPath } from "./revision/RevisionNamespace.ts";
import {
  diffTrees,
  encodeManifest,
  hydrateChangedFiles,
  sameCommit,
  scanTree,
} from "./revision/RevisionTree.ts";
import type { CheckpointAttempt, Persistence } from "./revision/RevisionTypes.ts";

export { KernelRevisionWorkspaceError };

export type KernelRevisionPersistence = ReturnType<typeof createFacetFilePersistence>;

export interface KernelRevisionWorkspaceOptions {
  readonly database: FacetStorage;
  readonly persistence: KernelRevisionPersistence;
  readonly filesystem: KernelFileSystem;
  /** KernelFileSystem path mounted at the revision root, such as `/workspace`. */
  readonly mountPath: string;
  readonly initial: ForkCommit;
}

export interface KernelRevisionWorkspace {
  readonly checkpoint: (operationId: string, signal: AbortSignal) => Promise<ForkCommit>;
  readonly apply: (input: {
    readonly before: ForkCommit;
    readonly after: ForkCommit;
    readonly changedInodes: readonly CommitInode[];
    readonly hydration: FileHydrationPort;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

/** Owns the durable revision journal and applies immutable revisions to one facet filesystem. */
export function createKernelRevisionWorkspace(
  options: KernelRevisionWorkspaceOptions,
): KernelRevisionWorkspace {
  const { database, filesystem, persistence } = options;
  const storage = persistence.storage;
  const mountPath = normalizeMountPath(options.mountPath);
  const rootEntry = filesystem.lstat(mountPath);
  const root = filesystem.resolve(mountPath);
  if (kernelFileByteViewStorage(root.mount.storage, root.inode) !== storage) {
    throw new KernelRevisionWorkspaceError(
      "EINVAL",
      "The revision root must use the persistence owner's storage",
    );
  }
  if (
    rootEntry.type !== "directory" ||
    rootEntry.ino !== root.inode ||
    root.stat.type !== "directory" ||
    storage.stat(root.inode).type !== "directory"
  ) {
    throw new KernelRevisionWorkspaceError(
      "EINVAL",
      "The revision root must be a directory in facet storage",
    );
  }
  assertDatabaseOwnsStorage(database, storage, root.inode);
  const rootInode = root.inode;
  const rootRealPath = filesystem.realpath(mountPath);
  installWorkspaceJournal(database);
  if (!hasWorkspaceState(database)) {
    ensureWorkspaceState(database, {
      at: options.initial,
      manifestJson: encodeManifest(scanTree(storage, rootInode)),
    });
  }
  const initialState = readState(database);
  if (
    initialState.at.repository !== options.initial.repository ||
    initialState.at.fork !== options.initial.fork
  ) {
    throw new KernelRevisionWorkspaceError(
      "ESTALE",
      "The facet workspace belongs to a different fork",
    );
  }

  const checkpointing = new Map<string, Promise<ForkCommit>>();
  let checkpointTail: Promise<void> = Promise.resolve();
  const runCheckpoint = async (operationId: string, signal: AbortSignal): Promise<ForkCommit> => {
    if (!operationId)
      throw new KernelRevisionWorkspaceError("EINVAL", "A checkpoint needs an operation id");
    signal.throwIfAborted();
    const completed = checkpointReceiptWithBase(database, operationId);
    if (completed) {
      if (
        completed.repository !== options.initial.repository ||
        completed.fork_name !== options.initial.fork
      ) {
        throw new KernelRevisionWorkspaceError("EINVAL", "The checkpoint operation id was reused");
      }
      return {
        repository: String(completed.repository),
        fork: String(completed.fork_name),
        commit: String(completed.commit_id),
      };
    }

    let attempt = readAttempt(database, operationId);
    if (attempt && !sameCommit(readState(database).at, attempt.at)) {
      deleteStaleAttempt(database, operationId, attempt.at);
      throw new KernelRevisionWorkspaceError("ESTALE", "The checkpoint attempt has a stale base");
    }
    if (!attempt) {
      const before = readState(database);
      const firstScan = scanTree(storage, rootInode);
      const firstDirty = readDirty(database);
      const firstChanges = diffTrees(
        before.manifest,
        firstScan,
        new Set(firstDirty.map((entry) => entry.inode)),
      );
      // Hydrate first so the saved epoch covers all in-flight lazy reads before checkpointing.
      await hydrateChangedFiles(firstChanges, storage, persistence, signal);
      signal.throwIfAborted();
      const current = scanTree(storage, rootInode);
      const dirty = readDirty(database);
      const epoch = readEpoch(database);
      const changed = diffTrees(
        before.manifest,
        current,
        new Set(dirty.map((entry) => entry.inode)),
      );
      const candidate: CheckpointAttempt = {
        at: before.at,
        manifest: encodeManifest(current),
        epoch,
        changed,
        dirty,
      };
      insertCheckpointAttempt(database, operationId, candidate);
      attempt = readAttempt(database, operationId);
      if (!attempt)
        throw new KernelRevisionWorkspaceError("EIO", "The checkpoint attempt was not recorded");
    }

    await hydrateChangedFiles(attempt.changed, storage, persistence, signal);
    signal.throwIfAborted();
    const current = readState(database);
    if (!sameCommit(current.at, attempt.at)) {
      deleteStaleAttempt(database, operationId, attempt.at);
      throw new KernelRevisionWorkspaceError(
        "ESTALE",
        "The facet revision advanced during checkpoint",
      );
    }
    if (readEpoch(database) !== attempt.epoch) {
      throw new KernelRevisionWorkspaceError(
        "LIVE_FILESYSTEM_DIVERGED",
        "The live filesystem changed after the checkpoint attempt was recorded",
      );
    }

    const committed = await persistence.commitTurn({
      at: attempt.at,
      turnId: operationId,
      changedInodes: attempt.changed,
      signal,
    });
    if (committed.status === "error") throw persistenceError(committed);
    return recordCheckpoint(database, operationId, attempt, committed.value.commit);
  };

  const checkpoint = (operationId: string, signal: AbortSignal): Promise<ForkCommit> => {
    const existing = checkpointing.get(operationId);
    if (existing) return existing;
    const pending = checkpointTail.then(() => runCheckpoint(operationId, signal));
    checkpointing.set(operationId, pending);
    checkpointTail = pending.then(
      () => undefined,
      () => undefined,
    );
    const clear = () => {
      if (checkpointing.get(operationId) === pending) checkpointing.delete(operationId);
    };
    void pending.then(clear, clear);
    return pending;
  };

  const applying = new Map<
    string,
    { readonly signature: string; readonly promise: Promise<void> }
  >();
  const runApply = async (input: Parameters<KernelRevisionWorkspace["apply"]>[0]) => {
    if (
      input.before.repository !== input.after.repository ||
      input.before.fork !== input.after.fork
    ) {
      throw new KernelRevisionWorkspaceError("EINVAL", "An apply cannot change fork identity");
    }
    const state = readState(database);
    if (sameCommit(state.at, input.after)) return;
    if (!sameCommit(state.at, input.before))
      throw new KernelRevisionWorkspaceError(
        "ESTALE",
        "The live workspace revision changed before apply",
      );
    const applyId = revisionApplyId(input.before, input.after);
    await applyRevision({
      database,
      filesystem,
      persistence,
      mountPath,
      rootRealPath,
      rootInode,
      before: input.before,
      after: input.after,
      changedInodes: input.changedInodes,
      hydration: input.hydration,
      baseline: state,
      applyId,
      signal: input.signal,
    });
  };
  const apply = (input: Parameters<KernelRevisionWorkspace["apply"]>[0]): Promise<void> => {
    const applyId = revisionApplyId(input.before, input.after);
    const signature = applySignature(input.changedInodes);
    const existing = applying.get(applyId);
    if (existing) {
      if (existing.signature !== signature) {
        return Promise.reject(
          new KernelRevisionWorkspaceError(
            "EINVAL",
            "An apply revision was reused with new contents",
          ),
        );
      }
      return existing.promise;
    }
    const promise = runApply(input);
    applying.set(applyId, { signature, promise });
    const clear = () => {
      if (applying.get(applyId)?.promise === promise) applying.delete(applyId);
    };
    void promise.then(clear, clear);
    return promise;
  };

  return { checkpoint, apply };
}

function revisionApplyId(before: ForkCommit, after: ForkCommit): string {
  return `${before.repository}:${before.fork}:${before.commit}->${after.commit}`;
}

function applySignature(changed: readonly CommitInode[]): string {
  return JSON.stringify(
    changed.map((entry) => ({
      inode: entry.inode.toString(),
      paths: [...entry.paths],
      removedPaths: [...entry.removedPaths],
      stat:
        entry.stat === null
          ? null
          : {
              ...entry.stat,
              size: entry.stat.size.toString(),
              nlink: entry.stat.nlink.toString(),
              atimeNs: entry.stat.atimeNs.toString(),
              mtimeNs: entry.stat.mtimeNs.toString(),
              ctimeNs: entry.stat.ctimeNs.toString(),
            },
      symlinkTarget: entry.symlinkTarget,
      posix: entry.posix ?? null,
    })),
  );
}

function assertDatabaseOwnsStorage(
  database: FacetStorage,
  storage: Persistence["storage"],
  rootInode: bigint,
): void {
  const original = storage.stat(rootInode).ctimeNs;
  const probe = original === -1n ? -2n : original - 1n;
  const rollback = new Error("roll back storage identity probe");
  let observed: bigint | undefined;
  try {
    database.transactionSync(() => {
      // The storage facade hides its SQLite handle, so verify both capabilities in a rollback-only write.
      database.sql.exec(
        "UPDATE kernel_fs_inode SET ctime_ns = ? WHERE ino = ?",
        probe.toString(),
        rootInode.toString(),
      );
      observed = storage.stat(rootInode).ctimeNs;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) {
      throw new KernelRevisionWorkspaceError(
        "EINVAL",
        "The revision database does not own the persistence storage",
      );
    }
  }
  if (observed !== probe || storage.stat(rootInode).ctimeNs !== original) {
    throw new KernelRevisionWorkspaceError(
      "EINVAL",
      "The revision database does not own the persistence storage",
    );
  }
}
