/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { callFs } from "./errors.ts";

export const IO_CHUNK_BYTES = 64 * 1024;

export function openFd(
  kernelFs: KernelFileSystem,
  path: string,
  flags: number,
  mode?: number,
): number {
  return callFs("open", path, () => kernelFs.open(path, flags, mode));
}

export function closeFd(kernelFs: KernelFileSystem, fd: number): void {
  callFs("close", undefined, () => kernelFs.close(fd));
}

export function readInto(
  kernelFs: KernelFileSystem,
  fd: number,
  target: Uint8Array,
  position: bigint | null,
): number {
  return callFs("read", undefined, () => kernelFs.read(fd, target, position));
}

export function writeFrom(
  kernelFs: KernelFileSystem,
  fd: number,
  source: Uint8Array,
  position: bigint | null,
): number {
  return callFs("write", undefined, () => kernelFs.write(fd, source, position));
}

export function readAll(kernelFs: KernelFileSystem, fd: number): NodeBuffer.Buffer {
  const chunks: NodeBuffer.Buffer[] = [];
  let length = 0;
  while (true) {
    const chunk = NodeBuffer.Buffer.allocUnsafe(IO_CHUNK_BYTES);
    const bytesRead = readInto(kernelFs, fd, chunk, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  return NodeBuffer.Buffer.concat(chunks, length);
}

export function writeAll(
  kernelFs: KernelFileSystem,
  fd: number,
  source: Uint8Array,
  position: bigint | null = null,
): number {
  let bytesWritten = 0;
  let nextPosition = position;
  while (bytesWritten < source.byteLength) {
    const written = writeFrom(kernelFs, fd, source.subarray(bytesWritten), nextPosition);
    if (written === 0) {
      const error = new Error("The filesystem returned a zero-byte write") as Error & {
        code: string;
      };
      error.code = "EIO";
      throw error;
    }
    bytesWritten += written;
    if (nextPosition !== null) nextPosition += BigInt(written);
  }
  return bytesWritten;
}

export function bytesOf(
  data: string | ArrayBuffer | ArrayBufferView,
  encoding: BufferEncoding,
): NodeBuffer.Buffer {
  if (typeof data === "string") return NodeBuffer.Buffer.from(data, encoding);
  if (data instanceof ArrayBuffer) return NodeBuffer.Buffer.from(data.slice(0));
  return NodeBuffer.Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function sliceView(view: ArrayBufferView, offset: number, length: number): Uint8Array {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > view.byteLength
  ) {
    throw Object.assign(new RangeError("The offset and length are out of range"), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return new Uint8Array(view.buffer, view.byteOffset + offset, length);
}
