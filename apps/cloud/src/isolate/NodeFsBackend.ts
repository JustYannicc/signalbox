import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";

/** Operations shared by the local kernel and the CLI's synchronous working set. */
export type NodeFsOperations = Pick<
  KernelFileSystem,
  | "access"
  | "chmod"
  | "fchmod"
  | "chown"
  | "fchown"
  | "close"
  | "fstat"
  | "fsetTimes"
  | "ftruncate"
  | "link"
  | "lstat"
  | "mkdir"
  | "open"
  | "read"
  | "readdir"
  | "readlink"
  | "realpath"
  | "rename"
  | "rmdir"
  | "setTimes"
  | "stat"
  | "symlink"
  | "sync"
  | "truncate"
  | "unlink"
  | "write"
>;

export type NodeFsOperation = keyof NodeFsOperations;
export type NodeFsArguments<K extends NodeFsOperation> = Parameters<NodeFsOperations[K]>;
export type NodeFsResult<K extends NodeFsOperation> = ReturnType<NodeFsOperations[K]>;

export interface NodeFsBackend extends NodeFsOperations {
  readonly cwd: string;
  readonly posixPolicy: KernelFileSystem["posixPolicy"];
  readonly descriptors: {
    get(fd: number): { readonly offset: bigint };
  };
  descriptorOffset?(fd: number, signal?: AbortSignal): Promise<bigint>;
  chdir(path: string): void;
  setUmask(mask: number): number;
  changeGeneration(): number | undefined;
  resolvesThroughDescriptors(path: string): boolean;
  onDispose(listener: () => void): () => void;
  openAsync(path: string, flags: number, mode?: number, signal?: AbortSignal): Promise<number>;
  readAsync(
    fd: number,
    target: Uint8Array,
    position: bigint | null,
    signal?: AbortSignal,
  ): Promise<number>;
  renameAsync(source: string, destination: string, signal?: AbortSignal): Promise<void>;
  /** An async Node API selects this branch before executing a filesystem leaf. */
  asynchronous?<K extends NodeFsOperation>(
    name: K,
    args: NodeFsArguments<K>,
    signal?: AbortSignal,
  ): Promise<NodeFsResult<K>>;
}
