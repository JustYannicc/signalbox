/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { fsOperation, runSync, type FsOperation } from "./operations.ts";
import { readIntoOperation, writeFromOperation, writeAllOperation, sliceView } from "./io.ts";
import { finitePosition } from "./path.ts";

export interface IoOptions {
  offset?: number;
  length?: number;
  position?: number | null;
}

export function ioOptions(offset?: number, length?: number, position?: number | null): IoOptions {
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(length === undefined ? {} : { length }),
    ...(position === undefined ? {} : { position }),
  };
}

function ioArgs(
  view: ArrayBufferView,
  options?: IoOptions,
): {
  buffer: Uint8Array;
  position: bigint | null;
} {
  const offset = options?.offset ?? 0;
  const length = options?.length ?? view.byteLength - offset;
  return {
    buffer: sliceView(view, offset, length),
    position: finitePosition(options?.position),
  };
}

export function* readOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  buffer: ArrayBufferView,
  offsetOrOptions: number | IoOptions = 0,
  length?: number,
  position?: number | null,
): FsOperation<number> {
  const options =
    typeof offsetOrOptions === "object"
      ? offsetOrOptions
      : ioOptions(offsetOrOptions, length, position);
  const args = ioArgs(buffer, options);
  return yield* fsOperation(
    "read",
    undefined,
    readIntoOperation(kernelFs, fd, args.buffer, args.position),
  );
}

export function* writeBufferOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  buffer: ArrayBufferView,
  offsetOrOptions: number | IoOptions = 0,
  length?: number,
  position?: number | null,
): FsOperation<number> {
  const options =
    typeof offsetOrOptions === "object"
      ? offsetOrOptions
      : ioOptions(offsetOrOptions, length, position);
  const args = ioArgs(buffer, options);
  return yield* fsOperation(
    "write",
    undefined,
    writeFromOperation(kernelFs, fd, args.buffer, args.position),
  );
}

export function* writeStringOperation(
  kernelFs: KernelFileSystem,
  fd: number,
  data: string,
  position?: number | null,
  encoding: BufferEncoding = "utf8",
): FsOperation<number> {
  const bytes = NodeBuffer.Buffer.from(data, encoding);
  return yield* fsOperation(
    "write",
    undefined,
    writeAllOperation(kernelFs, fd, bytes, finitePosition(position)),
  );
}

export const readSync = (...args: Parameters<typeof readOperation>) =>
  runSync(readOperation(...args));

export const writeBufferSync = (...args: Parameters<typeof writeBufferOperation>) =>
  runSync(writeBufferOperation(...args));

export const writeStringSync = (...args: Parameters<typeof writeStringOperation>) =>
  runSync(writeStringOperation(...args));
