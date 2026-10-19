export type KernelTscFileKind = "file" | "directory" | "symlink" | "other";

export type KernelTscFileSystemRequest =
  | { readonly op: "read" | "stat" | "readDirectory" | "realpath"; readonly path: string }
  | {
      readonly op: "write";
      readonly path: string;
      readonly data: Uint8Array;
      readonly append: boolean;
    }
  | { readonly op: "remove"; readonly path: string }
  | {
      readonly op: "chtimes";
      readonly path: string;
      readonly atimeNs?: bigint;
      readonly mtimeNs?: bigint;
    };

export type KernelTscFileSystemResponse =
  | { readonly kind: "missing" }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | {
      readonly kind: "stat";
      readonly type: "file" | "directory" | "other";
      readonly size: bigint;
      readonly mtimeNs: bigint;
    }
  | {
      readonly kind: "entries";
      /** Names are ordered by their UTF-8 bytes, matching Go's ReadDir order. */
      readonly entries: readonly { readonly name: string; readonly kind: KernelTscFileKind }[];
    }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "written" }
  | { readonly kind: "error"; readonly message: string };

/** Async host filesystem seam shared by local WASI and the tsc Worker RPC. */
export interface KernelTscFileSystemPort {
  execute(request: KernelTscFileSystemRequest): Promise<KernelTscFileSystemResponse>;
}
