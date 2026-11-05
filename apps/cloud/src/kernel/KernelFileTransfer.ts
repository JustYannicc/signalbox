import { RpcTarget } from "cloudflare:workers";
import type { HarnessFilesStoreResult } from "../harness/HarnessFilesStore.ts";

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

/** A checkpoint's existing immutable payloads are released as soon as its bounded transfer ends. */
export class KernelFileTransfer extends RpcTarget implements KernelFileTransferPort {
  #files: ReadonlyMap<string, Uint8Array> | undefined;
  constructor(files: HarnessFilesStoreResult["files"]) {
    super();
    this.#files = new Map(files.map((file) => [file.path, file.bytes]));
  }
  async read(path: string, offset: number, length: number) {
    if (this.#files === undefined)
      throw Object.assign(new Error("File transfer is closed"), { code: "EBADF" });
    const bytes = this.#files.get(path);
    if (
      bytes === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > KERNEL_FILE_TRANSFER_BYTES ||
      offset + length > bytes.length
    )
      throw new RangeError("Invalid file transfer range");
    return bytes.slice(offset, offset + length);
  }
  async close() {
    this.#files = undefined;
  }
}

export function kernelFileTransferManifest(
  files: HarnessFilesStoreResult["files"],
): KernelFileTransferManifest {
  return files.map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes.length }));
}

export async function readKernelFileTransfer(
  manifest: KernelFileTransferManifest,
  source: KernelFileTransferPort,
  signal?: AbortSignal,
): Promise<HarnessFilesStoreResult["files"]> {
  try {
    const result = [];
    for (const file of manifest) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0)
        throw new RangeError("Invalid checkpoint byte count");
      const bytes = new Uint8Array(file.bytes);
      for (let offset = 0; offset < bytes.length; offset += KERNEL_FILE_TRANSFER_BYTES) {
        signal?.throwIfAborted();
        const length = Math.min(KERNEL_FILE_TRANSFER_BYTES, bytes.length - offset);
        const chunk = await source.read(file.path, offset, length);
        if (chunk.length !== length) throw new Error("Checkpoint transfer ended early");
        bytes.set(chunk, offset);
      }
      result.push({ ...file, bytes });
    }
    signal?.throwIfAborted();
    return result;
  } finally {
    await source.close();
  }
}
