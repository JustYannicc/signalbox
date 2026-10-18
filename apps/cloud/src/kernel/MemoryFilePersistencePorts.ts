import type {
  CommitInode,
  FileCommitReceipt,
  FilePersistencePorts,
  FilePersistenceResult,
  ForkCommit,
} from "./FilePersistencePorts.ts";
import { FILE_CHUNK_BYTES } from "./FacetSqliteStorage.ts";
import type { Stat } from "./storage.ts";

export interface MemoryTreeEntry {
  readonly stat: Readonly<Stat>;
  readonly data: Uint8Array | null;
  readonly symlinkTarget: string | null;
}

export interface MemoryFetchCall {
  readonly at: ForkCommit;
  readonly paths: readonly string[];
  readonly status: "ok" | "error";
  readonly errorCode?: "NOT_FOUND" | "STALE_COMMIT" | "CANCELLED" | "IO_ERROR";
}

export interface MemoryCommittedTurn {
  readonly at: ForkCommit;
  readonly turnId: string;
  readonly receipt: FileCommitReceipt;
  readonly tree: Readonly<Record<string, MemoryTreeEntry>>;
}

/** An in-memory fake repository for persistence-port tests. */
export interface MemoryFilePersistenceFixture extends FilePersistencePorts {
  /** Adds or replaces one file in the exact repository, fork, and commit snapshot. */
  seedFile(at: ForkCommit, path: string, bytes: Uint8Array): void;
  /** Returns detached history so inspection cannot mutate the fake repository. */
  readonly fetchCalls: readonly MemoryFetchCall[];
  readonly committedTurns: readonly MemoryCommittedTurn[];
  /** Returns a detached snapshot, or undefined when that exact commit was never seeded. */
  inspectTree(at: ForkCommit): Readonly<Record<string, MemoryTreeEntry>> | undefined;
}

type MutableTreeEntry = MemoryTreeEntry;

type FetchCallRecord = Omit<MemoryFetchCall, "status" | "errorCode"> & {
  status: MemoryFetchCall["status"];
  errorCode?: MemoryFetchCall["errorCode"];
};

type CommittedTurnRecord = Omit<MemoryCommittedTurn, "tree"> & {
  tree: Map<string, MutableTreeEntry>;
};

const cloneAt = (at: ForkCommit): ForkCommit => ({ ...at });

const forkKey = (at: ForkCommit): string => JSON.stringify([at.repository, at.fork]);
const snapshotKey = (at: ForkCommit): string => JSON.stringify([at.repository, at.fork, at.commit]);
const turnKey = (at: ForkCommit, turnId: string): string =>
  JSON.stringify([at.repository, at.fork, at.commit, turnId]);

const cloneStat = (stat: Readonly<Stat>): Stat => ({ ...stat });

const cloneEntry = (entry: MutableTreeEntry): MemoryTreeEntry => ({
  stat: cloneStat(entry.stat),
  data: entry.data?.slice() ?? null,
  symlinkTarget: entry.symlinkTarget,
});

const inspectTree = (
  tree: Map<string, MutableTreeEntry>,
): Readonly<Record<string, MemoryTreeEntry>> =>
  Object.fromEntries([...tree].map(([path, entry]) => [path, cloneEntry(entry)]));

const cloneTree = (tree: Map<string, MutableTreeEntry>): Map<string, MutableTreeEntry> =>
  new Map(
    [...tree].map(([path, entry]) => [
      path,
      {
        stat: cloneStat(entry.stat),
        data: entry.data?.slice() ?? null,
        symlinkTarget: entry.symlinkTarget,
      } as const,
    ]),
  );

const error = (code: "NOT_FOUND" | "STALE_COMMIT" | "CANCELLED" | "IO_ERROR", message: string) =>
  ({ status: "error", error: { code, message } }) as const satisfies FilePersistenceResult<never>;

const cancelled = () => error("CANCELLED", "The file operation was cancelled");

const recordError = (
  call: FetchCallRecord,
  code: NonNullable<FetchCallRecord["errorCode"]>,
): void => {
  call.status = "error";
  call.errorCode = code;
};

async function readFileChunks(
  inode: CommitInode,
  signal: AbortSignal,
): Promise<Uint8Array | "cancelled" | "io-error"> {
  if (
    inode.stat === null ||
    inode.stat.size < 0n ||
    inode.stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return "io-error";

  const parts: Uint8Array[] = [];
  let size = 0n;
  try {
    for await (const chunk of inode.readChunks()) {
      if (signal.aborted) return "cancelled";
      if (!(chunk instanceof Uint8Array)) return "io-error";
      const copy = chunk.slice();
      size += BigInt(copy.byteLength);
      if (size > inode.stat.size) return "io-error";
      parts.push(copy);
    }
  } catch {
    return signal.aborted ? "cancelled" : "io-error";
  }
  if (signal.aborted) return "cancelled";
  if (size !== inode.stat.size) return "io-error";

  const bytes = new Uint8Array(Number(size));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export function createMemoryFilePersistencePorts(): MemoryFilePersistenceFixture {
  const snapshots = new Map<string, Map<string, MutableTreeEntry>>();
  const forkHeads = new Map<string, string>();
  const receipts = new Map<string, FileCommitReceipt>();
  const fetchHistory: FetchCallRecord[] = [];
  const commitHistory: CommittedTurnRecord[] = [];
  let nextCommit = 1;

  const fixture: MemoryFilePersistenceFixture = {
    seedFile(at, path, bytes) {
      const key = snapshotKey(at);
      const tree = snapshots.get(key) ?? new Map<string, MutableTreeEntry>();
      const data = bytes.slice();
      tree.set(path, {
        stat: {
          type: "file",
          size: BigInt(data.byteLength),
          nlink: 1n,
          atimeNs: 0n,
          mtimeNs: 0n,
          ctimeNs: 0n,
        },
        data,
        symlinkTarget: null,
      });
      snapshots.set(key, tree);
      forkHeads.set(forkKey(at), at.commit);
    },

    get fetchCalls() {
      return fetchHistory.map((call) => ({
        at: cloneAt(call.at),
        paths: [...call.paths],
        status: call.status,
        ...(call.errorCode ? { errorCode: call.errorCode } : {}),
      }));
    },

    get committedTurns() {
      return commitHistory.map((turn) => ({
        at: cloneAt(turn.at),
        turnId: turn.turnId,
        receipt: { ...turn.receipt },
        tree: inspectTree(turn.tree),
      }));
    },

    inspectTree(at) {
      const tree = snapshots.get(snapshotKey(at));
      return tree ? inspectTree(tree) : undefined;
    },

    hydration: {
      async fetch({ at, paths, signal }) {
        const call: FetchCallRecord = {
          at: cloneAt(at),
          paths: [...paths],
          status: "ok",
        };
        fetchHistory.push(call);

        if (signal.aborted) {
          recordError(call, "CANCELLED");
          return cancelled();
        }
        const tree = snapshots.get(snapshotKey(at));
        if (!tree) {
          recordError(call, "NOT_FOUND");
          return error("NOT_FOUND", "The requested fork commit was not found");
        }

        const files = [];
        for (const path of paths) {
          if (signal.aborted) {
            recordError(call, "CANCELLED");
            return cancelled();
          }
          const entry = tree.get(path);
          if (!entry || entry.stat.type !== "file" || entry.data === null) {
            recordError(call, "NOT_FOUND");
            return error("NOT_FOUND", `The requested file was not found: ${path}`);
          }
          const bytes = entry.data.slice();
          files.push({
            path,
            chunks: (async function* () {
              for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES) {
                if (signal.aborted) {
                  const abort = new Error("The file hydration was cancelled");
                  abort.name = "AbortError";
                  throw abort;
                }
                yield bytes.slice(offset, Math.min(offset + FILE_CHUNK_BYTES, bytes.byteLength));
              }
            })(),
          });
        }
        return { status: "ok", value: files } as const;
      },
    },

    commits: {
      async commit({ at, turnId, changedInodes, signal }) {
        if (signal.aborted) return cancelled();

        const idempotencyKey = turnKey(at, turnId);
        const originalReceipt = receipts.get(idempotencyKey);
        if (originalReceipt) return { status: "ok", value: { ...originalReceipt } } as const;

        const baseKey = snapshotKey(at);
        const base = snapshots.get(baseKey);
        if (!base) return error("NOT_FOUND", "The fork commit to update was not found");
        if (forkHeads.get(forkKey(at)) !== at.commit) {
          return error("STALE_COMMIT", "The fork has advanced since this commit");
        }

        const staged = cloneTree(base);
        try {
          for (const changed of changedInodes) {
            if (signal.aborted) return cancelled();
            for (const path of changed.removedPaths) staged.delete(path);
            if (changed.stat === null) {
              for (const path of changed.paths) staged.delete(path);
            }
          }

          for (const changed of changedInodes) {
            if (signal.aborted) return cancelled();
            if (changed.stat === null) continue;
            const stat = cloneStat(changed.stat);
            let data: Uint8Array | null = null;
            let symlinkTarget: string | null = null;
            if (stat.type === "file") {
              const contents = await readFileChunks(changed, signal);
              if (contents === "cancelled") return cancelled();
              if (contents === "io-error") {
                return error("IO_ERROR", "File contents did not match the committed stat");
              }
              data = contents;
            } else if (stat.type === "symlink") {
              if (changed.symlinkTarget === null) {
                return error("IO_ERROR", "A symlink commit must include its target");
              }
              symlinkTarget = changed.symlinkTarget;
            }

            for (const path of changed.paths) {
              staged.set(path, {
                stat: cloneStat(stat),
                data: data?.slice() ?? null,
                symlinkTarget,
              });
            }
          }
        } catch {
          return signal.aborted
            ? cancelled()
            : error("IO_ERROR", "The changed files could not be read");
        }

        if (signal.aborted) return cancelled();
        const replay = receipts.get(idempotencyKey);
        if (replay) return { status: "ok", value: { ...replay } } as const;
        if (forkHeads.get(forkKey(at)) !== at.commit) {
          return error("STALE_COMMIT", "The fork has advanced since this commit");
        }

        let commit: string;
        do {
          commit = `memory-commit-${nextCommit++}`;
        } while (snapshots.has(snapshotKey({ ...at, commit })));
        const receipt = { commit };
        const committedAt = { ...at, commit };
        snapshots.set(snapshotKey(committedAt), staged);
        forkHeads.set(forkKey(at), commit);
        receipts.set(idempotencyKey, receipt);
        commitHistory.push({
          at: cloneAt(at),
          turnId,
          receipt: { ...receipt },
          tree: cloneTree(staged),
        });
        return { status: "ok", value: { ...receipt } } as const;
      },
    },
  };

  return fixture;
}
