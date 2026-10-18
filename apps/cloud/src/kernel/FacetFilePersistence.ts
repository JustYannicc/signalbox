import type {
  ChangedInode,
  FilePersistencePorts,
  FilePersistenceResult,
  ForkCommit,
} from "./FilePersistencePorts.ts";
import { notYetFilePersistencePorts } from "./FilePersistencePorts.ts";
import { kernelError, kernelOk, type KernelResult, type KernelWakeRegistry } from "./KernelAbi.ts";
import type { Inode } from "./storage.ts";
import { type FacetStorage, StorageError } from "./sqlite/SqliteDatabase.ts";
import { createSqliteFileSystem, PendingContentError } from "./sqlite/SqliteFileSystem.ts";
import type { PendingFile } from "./sqlite/SqliteHydration.ts";
import { SqliteCommitSnapshot } from "./sqlite/SqliteCommitSnapshot.ts";

type Failure = Extract<FilePersistenceResult<never>, { status: "error" }>;
type FetchAttempt = {
  readonly waiters: Set<() => void>;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  failure: Failure | undefined;
};
const ioFailure = (message: string): Failure => ({
  status: "error",
  error: { code: "IO_ERROR", message },
});
const cancelled: Failure = {
  status: "error",
  error: { code: "CANCELLED", message: "File persistence owner exited" },
};
const abiFailure = (failure: Failure) =>
  kernelError(
    failure.error.code === "NOT_YET"
      ? "UNSUPPORTED"
      : failure.error.code === "STALE_COMMIT"
        ? "INVALID_ARGUMENT"
        : failure.error.code,
    failure.error.message,
  );

/** The syscall owner calls attempt again after its wake. Storage itself never starts remote I/O. */
export function createFacetFilePersistence(
  database: FacetStorage,
  nowNs: () => bigint,
  options: { readonly wakes: KernelWakeRegistry; readonly ports?: FilePersistencePorts },
) {
  const { storage, hydration } = createSqliteFileSystem(database, nowNs);
  const snapshots = new SqliteCommitSnapshot(database, storage);
  const ports = options.ports ?? notYetFilePersistencePorts;
  const fetches = new Map<Inode, FetchAttempt>();
  const committing = new Map<string, Promise<FilePersistenceResult<{ readonly commit: string }>>>();
  const owner = new AbortController();

  const start = (file: PendingFile) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    owner.signal.addEventListener("abort", abort, { once: true });
    if (owner.signal.aborted) controller.abort();
    const waiters = new Set<() => void>();
    // The microtask starts only after the attempt and its wake subscription exist.
    const entry: FetchAttempt = {
      controller,
      waiters,
      failure: undefined,
      done: Promise.resolve().then(async () => {
        try {
          storage.retain(file.inode);
          try {
            hydration.begin(file);
            const result = await ports.hydration.fetch({
              at: file.at,
              paths: [file.path],
              signal: controller.signal,
            });
            if (result.status === "error") {
              entry.failure = result;
              return;
            }
            if (result.value.length !== 1 || result.value[0]?.path !== file.path) {
              throw new Error("Hydration did not return exactly the requested path");
            }
            for await (const chunk of result.value[0].chunks) {
              if (controller.signal.aborted) {
                entry.failure = cancelled;
                return;
              }
              hydration.append(file.inode, chunk);
            }
            if (controller.signal.aborted) {
              entry.failure = cancelled;
              return;
            }
            hydration.publish(file.inode);
          } finally {
            hydration.discard(file.inode);
            storage.release(file.inode);
          }
        } catch (error) {
          entry.failure = controller.signal.aborted ? cancelled : ioFailure(String(error));
        } finally {
          owner.signal.removeEventListener("abort", abort);
          if (!entry.failure) fetches.delete(file.inode);
          for (const wake of [...waiters]) wake();
        }
      }),
    };
    fetches.set(file.inode, entry);
    return entry;
  };

  const attempt = <T>(operation: () => T): KernelResult<T> => {
    if (owner.signal.aborted) return abiFailure(cancelled);
    try {
      return kernelOk(operation());
    } catch (error) {
      if (!(error instanceof PendingContentError)) {
        return kernelError(
          error instanceof StorageError && error.code === "ENOENT" ? "NOT_FOUND" : "IO_ERROR",
          String(error),
        );
      }
      const previous = fetches.get(error.inode);
      if (previous?.failure) {
        return abiFailure(previous.failure);
      }
      const file = hydration.pending(error.inode);
      if (!file) return kernelError("IO_ERROR", "Hydration marker disappeared");
      // Register first so a token-limit failure never starts an unobserved fetch.
      let entry = previous;
      const registration = options.wakes.register((wake) => {
        entry ??= start(file);
        entry.waiters.add(wake);
        const subscribed = entry;
        return () => subscribed.waiters.delete(wake);
      });
      return registration.status === "ok"
        ? { status: "would_block", wakeToken: registration.value }
        : registration;
    }
  };

  const markUnhydrated = (file: PendingFile) => {
    if (owner.signal.aborted) throw new StorageError("ECANCELED");
    const stat = storage.stat(file.inode);
    if (stat.type !== "file" || stat.size !== file.size) throw new StorageError("EINVAL");
    if (!file.path.startsWith("/") || file.path.includes("\0")) throw new StorageError("EINVAL");
    hydration.attach({ ...file, at: { ...file.at } });
  };

  const waitForFetch = (done: Promise<void>, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        resolve(false);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void done.then(() => {
        signal.removeEventListener("abort", abort);
        resolve(!signal.aborted);
      });
    });

  const commitTurn = (input: {
    readonly at: ForkCommit;
    readonly turnId: string;
    readonly changedInodes: readonly ChangedInode[];
    readonly signal: AbortSignal;
  }): Promise<FilePersistenceResult<{ readonly commit: string }>> => {
    const key = JSON.stringify([input.at.repository, input.at.fork, input.at.commit, input.turnId]);
    const existing = committing.get(key);
    if (existing) return existing;
    const captured = {
      ...input,
      at: { ...input.at },
      changedInodes: input.changedInodes.map((change) => ({
        ...change,
        paths: [...change.paths],
        removedPaths: [...change.removedPaths],
      })),
    };
    const run = async () => {
      if (owner.signal.aborted || captured.signal.aborted) return cancelled;
      try {
        const signal = AbortSignal.any([owner.signal, captured.signal]);
        // A changed file can still depend on old bytes after a rename or metadata-only edit.
        for (const change of snapshots.has(captured.at, captured.turnId)
          ? []
          : captured.changedInodes) {
          const pending = hydration.pending(change.inode);
          if (!pending) continue;
          try {
            if (storage.stat(change.inode).nlink === 0n) continue;
          } catch (error) {
            if (error instanceof StorageError && error.code === "ENOENT") continue;
            throw error;
          }
          const entry = fetches.get(change.inode) ?? start(pending);
          if (!(await waitForFetch(entry.done, signal))) return cancelled;
          if (entry.failure) return entry.failure;
        }
        if (owner.signal.aborted || captured.signal.aborted) return cancelled;
        const changedInodes = snapshots.getOrCreate(
          captured.at,
          captured.turnId,
          captured.changedInodes,
        );
        const result = await ports.commits.commit({ ...captured, changedInodes, signal });
        if (result.status === "ok") snapshots.remove(captured.turnId);
        return result;
      } catch (error) {
        return error instanceof StorageError && error.code === "ESTALE"
          ? ({
              status: "error",
              error: { code: "STALE_COMMIT", message: "Turn snapshot belongs to a different base" },
            } as const)
          : ioFailure(String(error));
      }
    };
    const promise = run().finally(() => committing.delete(key));
    committing.set(key, promise);
    return promise;
  };

  return {
    storage,
    attempt,
    markUnhydrated,
    commitTurn,
    retryHydration(inode: Inode) {
      if (fetches.get(inode)?.failure) fetches.delete(inode);
    },
    dispose() {
      owner.abort();
      for (const entry of fetches.values()) {
        entry.controller.abort();
        for (const wake of [...entry.waiters]) wake();
      }
    },
  };
}
