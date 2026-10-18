/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { callFs } from "./errors.ts";
import { readInto, writeFrom, writeAll, sliceView } from "./io.ts";
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

export function readSync(
  kernelFs: KernelFileSystem,
  fd: number,
  buffer: ArrayBufferView,
  offsetOrOptions: number | IoOptions = 0,
  length?: number,
  position?: number | null,
): number {
  const options =
    typeof offsetOrOptions === "object"
      ? offsetOrOptions
      : ioOptions(offsetOrOptions, length, position);
  const args = ioArgs(buffer, options);
  return callFs("read", undefined, () => readInto(kernelFs, fd, args.buffer, args.position));
}

export function writeBufferSync(
  kernelFs: KernelFileSystem,
  fd: number,
  buffer: ArrayBufferView,
  offsetOrOptions: number | IoOptions = 0,
  length?: number,
  position?: number | null,
): number {
  const options =
    typeof offsetOrOptions === "object"
      ? offsetOrOptions
      : ioOptions(offsetOrOptions, length, position);
  const args = ioArgs(buffer, options);
  return callFs("write", undefined, () => writeFrom(kernelFs, fd, args.buffer, args.position));
}

export function writeStringSync(
  kernelFs: KernelFileSystem,
  fd: number,
  data: string,
  position?: number | null,
  encoding: BufferEncoding = "utf8",
): number {
  const bytes = NodeBuffer.Buffer.from(data, encoding);
  return callFs("write", undefined, () => writeAll(kernelFs, fd, bytes, finitePosition(position)));
}
