export const KERNEL_FILE_TRANSFER_BYTES = 64 * 1024;
export type KernelFileTransferManifest = ReadonlyArray<{
  readonly path: string;
  readonly mode: number;
  readonly kind?: "file" | "symlink";
  readonly bytes: number;
}>;
export interface KernelFileTransferPort {
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
