import type { Inode, Stat } from "./storage.ts";
import type { PosixMetadata } from "./PosixStorage.ts";

export interface ForkCommit {
  readonly repository: string;
  readonly fork: string;
  readonly commit: string;
}

export type FilePersistenceResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | {
      readonly status: "error";
      readonly error: {
        readonly code: "NOT_YET" | "NOT_FOUND" | "STALE_COMMIT" | "CANCELLED" | "IO_ERROR";
        readonly message: string;
      };
    };

export interface FetchedFile {
  readonly path: string;
  readonly chunks: AsyncIterable<Uint8Array>;
}

export interface FileHydrationPort {
  fetch(input: {
    readonly at: ForkCommit;
    readonly paths: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<FilePersistenceResult<readonly FetchedFile[]>>;
}

/** The turn owner supplies names, including removed names and deleted inodes. */
export interface ChangedInode {
  readonly inode: Inode;
  readonly paths: readonly string[];
  readonly removedPaths: readonly string[];
}

export interface CommitInode extends ChangedInode {
  readonly stat: Readonly<Stat> | null;
  readonly symlinkTarget: string | null;
  readonly posix?: Readonly<PosixMetadata> | null;
  /** Chunk streams read an immutable SQLite snapshot; consume them before commit settles. */
  readChunks(): AsyncIterable<Uint8Array>;
}

export interface FileCommitReceipt {
  readonly commit: string;
}

export interface FileCommitPort {
  /** A repeated turn at the same base must return the original receipt. */
  commit(input: {
    readonly at: ForkCommit;
    readonly turnId: string;
    readonly changedInodes: readonly CommitInode[];
    readonly signal: AbortSignal;
  }): Promise<FilePersistenceResult<FileCommitReceipt>>;
}

export interface FilePersistencePorts {
  readonly hydration: FileHydrationPort;
  readonly commits: FileCommitPort;
}

export const notYetFilePersistencePorts: FilePersistencePorts = {
  hydration: {
    async fetch() {
      return {
        status: "error",
        error: { code: "NOT_YET", message: "File hydration is not connected yet" },
      };
    },
  },
  commits: {
    async commit() {
      return {
        status: "error",
        error: { code: "NOT_YET", message: "Turn commits are not connected yet" },
      };
    },
  },
};
