import type { FileHydrationPort, ForkCommit } from "../kernel/FilePersistencePorts.ts";
import type { FacetStorage } from "../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { MachineHandle } from "./Machine.ts";
import type { MachineWorkspace } from "./MachineWorkspace.ts";
import { applyRevision } from "./workspace/FacetWorkspaceApply.ts";
import type { Persistence } from "./workspace/FacetWorkspaceState.ts";
import {
  FacetWorkspaceError,
  diffTrees,
  encodeChanged,
  encodeManifest,
  firstRow,
  hydrateChangedFiles,
  installWorkspaceJournal,
  persistenceError,
  readAttempt,
  readDirty,
  readEpoch,
  readState,
  sameCommit,
  scanTree,
} from "./workspace/FacetWorkspaceState.ts";
import { normalizeMountPath } from "./workspace/FacetWorkspaceNamespace.ts";
export { FacetWorkspaceError } from "./workspace/FacetWorkspaceState.ts";

export interface FacetWorkspaceOptions {
  readonly database: FacetStorage;
  readonly persistence: Persistence;
  readonly filesystem: KernelFileSystem;
  /** KernelFileSystem path mounted at the revision root, such as `/workspace`. */
  readonly mountPath: string;
  readonly initial: ForkCommit;
  /** Machine mount creation stays with the caller that owns that provider. */
  readonly mount: MachineWorkspace["prepare"];
  /** Reattachment stays with the same owner that creates the machine mount. */
  readonly resume?: MachineWorkspace["resume"];
}

/** Binds a live facet filesystem to immutable file revisions and an injected machine mount. */
export function createFacetWorkspace(options: FacetWorkspaceOptions): MachineWorkspace {
  const { database, filesystem, persistence } = options;
  const storage = persistence.storage;
  const mountPath = normalizeMountPath(options.mountPath);
  const rootInode = filesystem.lstat(mountPath).ino;
  if (
    filesystem.lstat(mountPath).type !== "directory" ||
    storage.stat(rootInode).type !== "directory"
  ) {
    throw new FacetWorkspaceError(
      "EINVAL",
      "The revision root must be a directory in facet storage",
    );
  }
  const rootRealPath = filesystem.realpath(mountPath);
  installWorkspaceJournal(database);
  if (
    !firstRow(
      database.sql.exec("SELECT singleton FROM kernel_fs_workspace_state WHERE singleton = 1"),
    )
  ) {
    const manifest = scanTree(storage, rootInode);
    database.transactionSync(() => {
      database.sql.exec(
        "INSERT OR IGNORE INTO kernel_fs_workspace_state (singleton, repository, fork_name, commit_id, manifest_json, epoch, baseline_epoch) VALUES (1, ?, ?, ?, ?, 0, 0)",
        options.initial.repository,
        options.initial.fork,
        options.initial.commit,
        encodeManifest(manifest),
      );
      database.sql.exec("DELETE FROM kernel_fs_workspace_dirty_inode");
    });
  }
  const initialState = readState(database);
  if (
    initialState.at.repository !== options.initial.repository ||
    initialState.at.fork !== options.initial.fork
  ) {
    throw new FacetWorkspaceError("ESTALE", "The facet workspace belongs to a different fork");
  }

  const checkpointing = new Map<string, Promise<ForkCommit>>();
  const runCheckpoint = async (operationId: string, signal: AbortSignal): Promise<ForkCommit> => {
    if (!operationId) throw new FacetWorkspaceError("EINVAL", "A checkpoint needs an operation id");
    signal.throwIfAborted();
    const completed = firstRow(
      database.sql.exec(
        "SELECT repository, fork_name, commit_id FROM kernel_fs_workspace_checkpoint WHERE operation_id = ?",
        operationId,
      ),
    );
    if (completed) {
      return {
        repository: String(completed.repository),
        fork: String(completed.fork_name),
        commit: String(completed.commit_id),
      };
    }

    let attempt = readAttempt(database, operationId);
    if (!attempt) {
      const before = readState(database);
      const firstScan = scanTree(storage, rootInode);
      const firstDirty = readDirty(database);
      const firstChanges = diffTrees(
        before.manifest,
        firstScan,
        new Set(firstDirty.map((entry) => entry.inode)),
      );
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
      attempt = { at: before.at, manifest: encodeManifest(current), epoch, changed, dirty };
      database.transactionSync(() => {
        const still = readState(database);
        if (!sameCommit(still.at, before.at))
          throw new FacetWorkspaceError("ESTALE", "The facet revision advanced during checkpoint");
        database.sql.exec(
          "INSERT OR IGNORE INTO kernel_fs_workspace_attempt (operation_id, repository, fork_name, base_commit, manifest_json, epoch, changed_json, dirty_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          operationId,
          attempt!.at.repository,
          attempt!.at.fork,
          attempt!.at.commit,
          attempt!.manifest,
          attempt!.epoch,
          JSON.stringify(attempt!.changed.map(encodeChanged)),
          JSON.stringify(attempt!.dirty),
        );
      });
      attempt = readAttempt(database, operationId)!;
    }

    await hydrateChangedFiles(attempt.changed, storage, persistence, signal);
    signal.throwIfAborted();
    const current = readState(database);
    if (!sameCommit(current.at, attempt.at)) {
      throw new FacetWorkspaceError("ESTALE", "The facet revision advanced during checkpoint");
    }
    if (readEpoch(database) !== attempt.epoch) {
      throw new FacetWorkspaceError(
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
    const after = { ...attempt.at, commit: committed.value.commit };
    const result = database.transactionSync(() => {
      const alreadyCompleted = firstRow(
        database.sql.exec(
          "SELECT repository, fork_name, base_commit, commit_id FROM kernel_fs_workspace_checkpoint WHERE operation_id = ?",
          operationId,
        ),
      );
      if (alreadyCompleted) {
        if (
          alreadyCompleted.repository !== attempt!.at.repository ||
          alreadyCompleted.fork_name !== attempt!.at.fork ||
          alreadyCompleted.base_commit !== attempt!.at.commit
        ) {
          throw new FacetWorkspaceError("EINVAL", "The checkpoint operation id was reused");
        }
        return {
          repository: String(alreadyCompleted.repository),
          fork: String(alreadyCompleted.fork_name),
          commit: String(alreadyCompleted.commit_id),
        };
      }
      const current = readState(database);
      if (!sameCommit(current.at, attempt!.at))
        throw new FacetWorkspaceError("ESTALE", "The facet revision advanced during checkpoint");
      database.sql.exec(
        "UPDATE kernel_fs_workspace_state SET commit_id = ?, manifest_json = ?, baseline_epoch = ? WHERE singleton = 1",
        after.commit,
        attempt!.manifest,
        attempt!.epoch,
      );
      for (const dirty of attempt!.dirty) {
        database.sql.exec(
          "DELETE FROM kernel_fs_workspace_dirty_inode WHERE ino = ? AND version = ?",
          dirty.inode,
          dirty.version,
        );
      }
      database.sql.exec(
        "INSERT INTO kernel_fs_workspace_checkpoint VALUES (?, ?, ?, ?, ?, ?)",
        operationId,
        attempt!.at.repository,
        attempt!.at.fork,
        attempt!.at.commit,
        after.commit,
        attempt!.epoch,
      );
      database.sql.exec(
        "DELETE FROM kernel_fs_workspace_attempt WHERE operation_id = ?",
        operationId,
      );
      return after;
    });
    return result;
  };
  const checkpoint = (operationId: string, signal: AbortSignal): Promise<ForkCommit> => {
    const existing = checkpointing.get(operationId);
    if (existing) return existing;
    const pending = runCheckpoint(operationId, signal);
    checkpointing.set(operationId, pending);
    const clear = () => {
      if (checkpointing.get(operationId) === pending) checkpointing.delete(operationId);
    };
    void pending.then(clear, clear);
    return pending;
  };

  const workspace: MachineWorkspace = {
    checkpoint,

    prepare: (
      machine: MachineHandle,
      at: ForkCommit,
      hydration: FileHydrationPort,
      signal: AbortSignal,
    ) => options.mount(machine, at, hydration, signal),

    ...(options.resume
      ? {
          resume: async (input: Parameters<NonNullable<MachineWorkspace["resume"]>>[0]) => {
            if (
              !input.operationId ||
              !input.machine.id ||
              !Number.isSafeInteger(input.machine.generation) ||
              input.machine.generation < 1
            ) {
              throw new FacetWorkspaceError("EINVAL", "Invalid machine workspace ownership");
            }
            const resumed = await options.resume!(input);
            const { ownership } = resumed;
            if (
              ownership.operationId !== input.operationId ||
              ownership.machineId !== input.machine.id ||
              ownership.generation !== input.machine.generation ||
              !sameCommit(ownership.before, input.before)
            ) {
              throw new FacetWorkspaceError(
                "ESTALE",
                "The resumed machine workspace belongs to another operation or revision",
              );
            }
            return {
              mount: resumed.mount,
              ownership: Object.freeze({
                operationId: input.operationId,
                machineId: input.machine.id,
                generation: input.machine.generation,
                before: { ...input.before },
              }),
            };
          },
        }
      : {}),

    apply: async ({ before, after, changedInodes, hydration, signal }) => {
      const state = readState(database);
      if (sameCommit(state.at, after)) return;
      if (!sameCommit(state.at, before))
        throw new FacetWorkspaceError("ESTALE", "The live workspace revision changed before apply");
      await applyRevision({
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
        baseline: state,
        signal,
      });
    },
  };
  return workspace;
}
