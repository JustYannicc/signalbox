/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { checkAbort } from "./abort.ts";
import { codedError } from "./errors.ts";
import { bytesOf, openFdOperation, readAllOperation, writeAllOperation } from "./io.ts";
import { fsOperation, leaf, runSync, type FsOperation } from "./operations.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import { pathOrFd, type PathOrFd } from "./path.ts";

export interface ReadFileOptions {
  encoding?: BufferEncoding | "buffer" | null;
  flag?: string | number;
  signal?: AbortSignal;
}

export interface WriteFileOptions extends Omit<ReadFileOptions, "encoding"> {
  encoding?: BufferEncoding | null;
  mode?: number;
  flush?: boolean;
}

export function readOptions(options?: BufferEncoding | ReadFileOptions | null): ReadFileOptions {
  if (typeof options === "string") return { encoding: options };
  return options ?? {};
}

export function writeOptions(options?: BufferEncoding | WriteFileOptions | null): WriteFileOptions {
  if (typeof options === "string") return { encoding: options };
  return options ?? {};
}

function decoded(bytes: NodeBuffer.Buffer, encoding: BufferEncoding | "buffer" | null | undefined) {
  return encoding && encoding !== "buffer" ? bytes.toString(encoding) : bytes;
}

export function* readFileOperation(
  kernelFs: KernelFileSystem,
  path: PathOrFd,
  options?: BufferEncoding | ReadFileOptions | null,
): FsOperation<NodeBuffer.Buffer | string> {
  const input = pathOrFd(path);
  const normalized = readOptions(options);
  checkAbort(normalized.signal);
  const operation = function* (): FsOperation<NodeBuffer.Buffer | string> {
    if (typeof input === "number")
      return decoded(yield* readAllOperation(kernelFs, input), normalized.encoding);
    const fd = yield* openFdOperation(kernelFs, input, parseOpenFlags(normalized.flag ?? "r"));
    try {
      checkAbort(normalized.signal);
      return decoded(yield* readAllOperation(kernelFs, fd), normalized.encoding);
    } finally {
      yield* leaf(() => kernelFs.close(fd), true);
    }
  };
  return yield* fsOperation("readFile", typeof input === "string" ? input : undefined, operation());
}

export function* writeFileOperation(
  kernelFs: KernelFileSystem,
  path: PathOrFd,
  data: string | ArrayBuffer | ArrayBufferView,
  options?: BufferEncoding | WriteFileOptions | null,
): FsOperation<void> {
  const input = pathOrFd(path);
  const normalized = writeOptions(options);
  checkAbort(normalized.signal);
  const bytes = bytesOf(data, normalized.encoding ?? "utf8");
  const operation = function* (): FsOperation<void> {
    if (typeof input === "number") {
      yield* writeAllOperation(kernelFs, input, bytes);
      if (normalized.flush) yield* leaf(() => kernelFs.sync(input, false));
      return;
    }
    const fd = yield* openFdOperation(
      kernelFs,
      input,
      parseOpenFlags(normalized.flag ?? "w"),
      normalizeMode(normalized.mode),
    );
    try {
      yield* writeAllOperation(kernelFs, fd, bytes);
      if (normalized.flush) yield* leaf(() => kernelFs.sync(fd, false));
    } finally {
      yield* leaf(() => kernelFs.close(fd), true);
    }
  };
  yield* fsOperation("writeFile", typeof input === "string" ? input : undefined, operation());
}

export function* appendFileOperation(
  kernelFs: KernelFileSystem,
  path: PathOrFd,
  data: string | ArrayBuffer | ArrayBufferView,
  options?: BufferEncoding | WriteFileOptions | null,
): FsOperation<void> {
  const input = pathOrFd(path);
  const normalized = writeOptions(options);
  checkAbort(normalized.signal);
  const bytes = bytesOf(data, normalized.encoding ?? "utf8");
  const operation = function* (): FsOperation<void> {
    if (typeof input === "number") {
      yield* writeAllOperation(kernelFs, input, bytes);
      if (normalized.flush) yield* leaf(() => kernelFs.sync(input, false));
      return;
    }
    const fd = yield* openFdOperation(
      kernelFs,
      input,
      parseOpenFlags(normalized.flag ?? "a"),
      normalizeMode(normalized.mode),
    );
    try {
      yield* writeAllOperation(kernelFs, fd, bytes);
      if (normalized.flush) yield* leaf(() => kernelFs.sync(fd, false));
    } finally {
      yield* leaf(() => kernelFs.close(fd), true);
    }
  };
  yield* fsOperation("appendFile", typeof input === "string" ? input : undefined, operation());
}

export function* copyFileOperation(
  kernelFs: KernelFileSystem,
  source: string,
  destination: string,
  flags = 0,
): FsOperation<void> {
  const exclusive = (flags & 1) !== 0;
  yield* fsOperation(
    "copyfile",
    source,
    (function* (): FsOperation<void> {
      if ((flags & ~3) !== 0)
        throw codedError("ENOTSUP", "forced reflink copying is not supported", "copyfile");
      const sourceFd = yield* openFdOperation(kernelFs, source, parseOpenFlags("r"));
      let destinationFd: number | undefined;
      try {
        const data = yield* readAllOperation(kernelFs, sourceFd);
        destinationFd = yield* openFdOperation(
          kernelFs,
          destination,
          parseOpenFlags(exclusive ? "wx" : "w"),
        );
        yield* writeAllOperation(kernelFs, destinationFd, data);
      } finally {
        try {
          yield* leaf(() => kernelFs.close(sourceFd), true);
        } finally {
          if (destinationFd !== undefined) {
            const fd = destinationFd;
            yield* leaf(() => kernelFs.close(fd), true);
          }
        }
      }
    })(),
    destination,
  );
}

export const readFileSync = (...args: Parameters<typeof readFileOperation>) =>
  runSync(readFileOperation(...args));

export const writeFileSync = (...args: Parameters<typeof writeFileOperation>) =>
  runSync(writeFileOperation(...args));

export const appendFileSync = (...args: Parameters<typeof appendFileOperation>) =>
  runSync(appendFileOperation(...args));

export const copyFileSync = (...args: Parameters<typeof copyFileOperation>) =>
  runSync(copyFileOperation(...args));
