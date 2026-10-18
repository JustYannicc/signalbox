/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { fsOperation, leaf, runSync, type FsOperation } from "./operations.ts";

export const IO_CHUNK_BYTES = 64 * 1024;

export function* openFdOperation(
  kernelFs: KernelFileSystem,
  path: string,
  flags: number,
  mode?: number,
): FsOperation<number> {
  return yield* fsOperation(
    "open",
    path,
    leaf(() => kernelFs.open(path, flags, mode)),
  );
}

export function* closeFdOperation(kernelFs: KernelFileSystem, fd: number): FsOperation<void> {
  yield* fsOperation(
    "close",
    undefined,
    leaf(() => kernelFs.close(fd), true),
  );
}

export function* readIntoOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  target: Uint8Array,
  position: bigint | null,
): FsOperation<number> {
  return yield* fsOperation(
    "read",
    undefined,
    leaf(() => kernelFs.read(fd, target, position)),
  );
}

export function* writeFromOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  source: Uint8Array,
  position: bigint | null,
): FsOperation<number> {
  return yield* fsOperation(
    "write",
    undefined,
    leaf(() => kernelFs.write(fd, source, position)),
  );
}

export function* readAllOperation(
  kernelFs: KernelFileSystem,
  fd: number,
): FsOperation<NodeBuffer.Buffer> {
  const chunks: NodeBuffer.Buffer[] = [];
  let length = 0;
  while (true) {
    const chunk = NodeBuffer.Buffer.allocUnsafe(IO_CHUNK_BYTES);
    const bytesRead = yield* readIntoOperation(kernelFs, fd, chunk, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  return NodeBuffer.Buffer.concat(chunks, length);
}

export function* writeAllOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  source: Uint8Array,
  position: bigint | null = null,
  onWrite?: (bytes: number) => void,
): FsOperation<number> {
  let bytesWritten = 0;
  let nextPosition = position;
  while (bytesWritten < source.byteLength) {
    const written = yield* writeFromOperation(
      kernelFs,
      fd,
      source.subarray(bytesWritten),
      nextPosition,
    );
    if (written === 0) {
      const error = new Error("The filesystem returned a zero-byte write") as Error & {
        code: string;
      };
      error.code = "EIO";
      throw error;
    }
    bytesWritten += written;
    onWrite?.(written);
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

export const openFd = (...args: Parameters<typeof openFdOperation>) =>
  runSync(openFdOperation(...args));

export const closeFd = (...args: Parameters<typeof closeFdOperation>) =>
  runSync(closeFdOperation(...args));

export const readInto = (...args: Parameters<typeof readIntoOperation>) =>
  runSync(readIntoOperation(...args));

export const writeFrom = (...args: Parameters<typeof writeFromOperation>) =>
  runSync(writeFromOperation(...args));

export const readAll = (...args: Parameters<typeof readAllOperation>) =>
  runSync(readAllOperation(...args));

export const writeAll = (...args: Parameters<typeof writeAllOperation>) =>
  runSync(writeAllOperation(...args));
