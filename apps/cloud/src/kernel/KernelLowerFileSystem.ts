import type { PosixMetadata } from "./PosixStorage.ts";
import type { Inode, MaybePromise, Stat } from "./storage.ts";

/** A lower-source failure that must stop the command instead of becoming a guest errno. */
export interface KernelFileSystemUnavailableContext {
  readonly operations: readonly {
    readonly operation: string;
    readonly path: string;
  }[];
  readonly generationState: {
    readonly requested: number | null;
    readonly current: number | null;
    readonly generationAbsent: boolean;
    readonly pristine: boolean;
    readonly imageDigest?: string;
  };
}

export interface KernelFileSystemUnavailableOptions extends ErrorOptions {
  readonly filesystemContext?: KernelFileSystemUnavailableContext;
}

export class KernelFileSystemUnavailable extends Error {
  readonly fatal = true;
  readonly filesystemContext: KernelFileSystemUnavailableContext | undefined;

  constructor(
    message = "Lower filesystem source is unavailable",
    options?: KernelFileSystemUnavailableOptions,
  ) {
    const { filesystemContext, ...errorOptions } = options ?? {};
    super(
      filesystemContext === undefined
        ? message
        : `${message} [filesystemContext=${JSON.stringify(filesystemContext)}]`,
      errorOptions,
    );
    this.name = "KernelFileSystemUnavailable";
    this.filesystemContext = filesystemContext;
  }
}

/** Verified lower bytes are not currently available without asynchronous I/O. */
export class KernelSynchronousFileBytesUnavailable extends KernelFileSystemUnavailable {
  constructor(path: string, options?: KernelFileSystemUnavailableOptions) {
    super(`Synchronous lower-file bytes are unavailable: ${path}`, options);
    this.name = "KernelSynchronousFileBytesUnavailable";
  }
}

/** A lower entry's native metadata, kept separate from the kernel's virtual inode identity. */
export interface KernelLowerFileSystemEntry {
  readonly path: string;
  readonly stat: Stat;
  readonly metadata: PosixMetadata;
  readonly nativeIno?: bigint;
  readonly nativeDev?: bigint;
  /** Physical lower parent for relative symlinks exposed through an ancestor alias. */
  readonly symlinkParent?: string;
}

/** A directory name whose native type cannot be represented by this filesystem. */
export interface KernelLowerFileSystemUnsupportedEntry {
  readonly path: string;
  readonly unsupportedType: string;
}

export type KernelLowerFileSystemDirectoryEntry =
  | KernelLowerFileSystemEntry
  | KernelLowerFileSystemUnsupportedEntry;

/** Batch directory reads keep path-local denials separate from transport failures. */
export type KernelLowerFileSystemDirectoryResult =
  | { readonly kind: "entries"; readonly entries: readonly KernelLowerFileSystemDirectoryEntry[] }
  | { readonly kind: "error"; readonly error: Error }
  | undefined;

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
  /** Returns immediate children only when the complete directory listing is known locally. */
  readdirKnown?(path: string): readonly KernelLowerFileSystemDirectoryEntry[] | undefined;
  /** Returns a symlink target only when it is known locally. */
  readlinkKnown?(path: string): string | undefined;
  /** Returns immediate children, including their metadata, or `undefined` when absent. */
  readdir(
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly KernelLowerFileSystemDirectoryEntry[] | undefined>;
  /** Optional batch path for sources whose transport already accepts many directory reads. */
  readdirMany?(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly KernelLowerFileSystemDirectoryResult[]>;
  readlink(path: string, signal?: AbortSignal): Promise<string>;
  /** Optional batch path for warming symlink targets from a refreshed directory snapshot. */
  readlinkMany?(paths: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
  /** Reads already verified, authoritative bytes without I/O; undefined means unavailable. */
  readKnown?(path: string, offset: bigint, length: number): Uint8Array | undefined;
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
  /** Clears old metadata and primes an authoritative lower generation, including merged directories. */
  refresh(paths: readonly string[], signal?: AbortSignal): Promise<void>;
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
