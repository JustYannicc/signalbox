import type { Inode, Storage } from "./storage.ts";
import { KernelSynchronousFileBytesUnavailable } from "./KernelLowerFileSystem.ts";
import type { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";
import { currentKernelSignal } from "./process/KernelExecution.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

const COPY_CHUNK_BYTES = 64 * 1024;

export async function copyLowerFileContents(
  source: KernelLowerFileSystemSourceIndex,
  upper: Storage,
  lowerInode: Inode,
  upperInode: Inode,
  size: bigint,
  signal = currentKernelSignal(),
): Promise<void> {
  const buffer = new Uint8Array(COPY_CHUNK_BYTES);
  let offset = 0n;
  while (offset < size) {
    signal?.throwIfAborted();
    const length = Number(
      size - offset < BigInt(buffer.byteLength) ? size - offset : BigInt(buffer.byteLength),
    );
    const target = buffer.subarray(0, length);
    const bytesRead = await source.readInto(lowerInode, offset, target);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length)
      throw kernelError("EIO", "Lower file returned an invalid byte count");
    if (bytesRead === 0) throw kernelError("EIO", "Lower file ended before its metadata size");

    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      const written = await upper.write(
        upperInode,
        offset + BigInt(bytesWritten),
        target.subarray(bytesWritten, bytesRead),
      );
      if (!Number.isInteger(written) || written <= 0 || written > bytesRead - bytesWritten)
        throw kernelError("EIO", "Upper file returned an invalid byte count");
      bytesWritten += written;
    }
    offset += BigInt(bytesRead);
  }
}

export function copyLowerFileContentsSync(
  source: KernelLowerFileSystemSourceIndex,
  upper: Storage,
  lowerInode: Inode,
  upperInode: Inode,
  size: bigint,
): void {
  const buffer = new Uint8Array(COPY_CHUNK_BYTES);
  let offset = 0n;
  while (offset < size) {
    currentKernelSignal()?.throwIfAborted();
    const length = Number(
      size - offset < BigInt(buffer.byteLength) ? size - offset : BigInt(buffer.byteLength),
    );
    const target = buffer.subarray(0, length);
    const bytesRead = source.readInto(lowerInode, offset, target);
    if (isPromiseLike(bytesRead)) {
      void bytesRead.catch(() => undefined);
      throw new KernelSynchronousFileBytesUnavailable(
        source.pathForInode(lowerInode) ?? "<unknown>",
      );
    }
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length)
      throw kernelError("EIO", "Lower file returned an invalid byte count");
    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      const written = upper.write(
        upperInode,
        offset + BigInt(bytesWritten),
        target.subarray(bytesWritten, bytesRead),
      );
      if (!Number.isInteger(written) || written <= 0 || written > bytesRead - bytesWritten)
        throw kernelError("EIO", "Upper file returned an invalid byte count");
      bytesWritten += written;
    }
    offset += BigInt(bytesRead);
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}
