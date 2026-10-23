import type { PosixMetadata } from "./PosixStorage.ts";
import type { Inode, MaybePromise, Stat } from "./storage.ts";

/** A lower-source failure that must stop the command instead of becoming a guest errno. */
export class KernelFileSystemUnavailable extends Error {
  readonly fatal = true;

  constructor(message = "Lower filesystem source is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelFileSystemUnavailable";
  }
}

/** A lower entry's native metadata, kept separate from the kernel's virtual inode identity. */
export interface KernelLowerFileSystemEntry {
  readonly path: string;
  readonly stat: Stat;
  readonly metadata: PosixMetadata;
  readonly nativeIno?: bigint;
  readonly nativeDev?: bigint;
}

/** Read-only source for a lower POSIX filesystem. Paths are canonical absolute guest paths. */
export interface KernelLowerFileSystemSource {
  /**
   * Returns results in input order. `undefined` means absent. Sources may return synchronously
   * when the answer is local and authoritative; live lookups may suspend. Ordinary POSIX errors
   * reject the call unchanged; backend or transport failure rejects with KernelFileSystemUnavailable.
   */
  lookup(
    paths: readonly string[],
    signal?: AbortSignal,
  ): MaybePromise<readonly (KernelLowerFileSystemEntry | undefined)[]>;
  /** Returns aligned answers only when every path is known without I/O; undefined means unknown. */
  lookupKnown?(
    paths: readonly string[],
  ): readonly (KernelLowerFileSystemEntry | undefined)[] | undefined;
  /** Returns immediate children, including their metadata, or `undefined` when absent. */
  readdir(
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly KernelLowerFileSystemEntry[] | undefined>;
  readlink(path: string, signal?: AbortSignal): Promise<string>;
  /** Reads at most `length` bytes from `offset`; file contents are fetched only on demand. */
  read(path: string, offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export type KernelLowerFileSystemKnownLookup =
  | { readonly kind: "entry"; readonly inode: Inode }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

/** Controls an explicitly attached lower layer shared by a KernelFileSystem and its forks. */
export interface KernelLowerFileSystem {
  /** Batch-primes path metadata and ancestors until invalidated; file bytes remain lazy. */
  prepare(paths: readonly string[], signal?: AbortSignal): Promise<void>;
  /** True only when the path resolves to the lower layer after upper-layer precedence. */
  isLower(path: string, signal?: AbortSignal): Promise<boolean>;
  /** Drops metadata, directory, and missing-path caches after a machine execution. */
  invalidate(): void;
  /** Detaches this installation after its Computer has drained; stale handles cannot detach newer owners. */
  dispose(): void;
}

/** WASI hook invoked before a path_open candidate so a caller can batch PATH siblings. */
export type KernelLowerFileSystemPathSearch = (
  path: string,
  directoryFd: number,
  signal?: AbortSignal,
) => Promise<void>;
