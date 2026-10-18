/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { callFs, codedError } from "./errors.ts";
import { bytesOf, openFd, readAll, writeAll } from "./io.ts";
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

function readOptions(options?: BufferEncoding | ReadFileOptions | null): ReadFileOptions {
  if (typeof options === "string") return { encoding: options };
  return options ?? {};
}

function writeOptions(options?: BufferEncoding | WriteFileOptions | null): WriteFileOptions {
  if (typeof options === "string") return { encoding: options };
  return options ?? {};
}

function signalCheck(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted") as Error & {
      code: string;
      cause?: unknown;
    };
    error.code = "ABORT_ERR";
    error.cause = signal.reason;
    throw error;
  }
}

function decoded(bytes: NodeBuffer.Buffer, encoding: BufferEncoding | "buffer" | null | undefined) {
  return encoding && encoding !== "buffer" ? bytes.toString(encoding) : bytes;
}

export function readFileSync(
  kernelFs: KernelFileSystem,
  path: PathOrFd,
  options?: BufferEncoding | ReadFileOptions | null,
): NodeBuffer.Buffer | string {
  const input = pathOrFd(path);
  const normalized = readOptions(options);
  signalCheck(normalized.signal);
  const operation = () => {
    if (typeof input === "number") return decoded(readAll(kernelFs, input), normalized.encoding);
    const fd = openFd(kernelFs, input, parseOpenFlags(normalized.flag ?? "r"));
    try {
      signalCheck(normalized.signal);
      return decoded(readAll(kernelFs, fd), normalized.encoding);
    } finally {
      kernelFs.close(fd);
    }
  };
  return callFs("readFile", typeof input === "string" ? input : undefined, operation);
}

export function writeFileSync(
  kernelFs: KernelFileSystem,
  path: PathOrFd,
  data: string | ArrayBuffer | ArrayBufferView,
  options?: BufferEncoding | WriteFileOptions | null,
): void {
  const input = pathOrFd(path);
  const normalized = writeOptions(options);
  signalCheck(normalized.signal);
  const bytes = bytesOf(data, normalized.encoding ?? "utf8");
  const operation = () => {
    if (typeof input === "number") {
      writeAll(kernelFs, input, bytes);
      if (normalized.flush) kernelFs.sync(input, false);
      return;
    }
    const fd = openFd(
      kernelFs,
      input,
      parseOpenFlags(normalized.flag ?? "w"),
      normalizeMode(normalized.mode),
    );
    try {
      writeAll(kernelFs, fd, bytes);
      if (normalized.flush) kernelFs.sync(fd, false);
    } finally {
      kernelFs.close(fd);
    }
  };
  callFs("writeFile", typeof input === "string" ? input : undefined, operation);
}

export function appendFileSync(
  kernelFs: KernelFileSystem,
  path: PathOrFd,
  data: string | ArrayBuffer | ArrayBufferView,
  options?: BufferEncoding | WriteFileOptions | null,
): void {
  const input = pathOrFd(path);
  const normalized = writeOptions(options);
  signalCheck(normalized.signal);
  const bytes = bytesOf(data, normalized.encoding ?? "utf8");
  const operation = () => {
    if (typeof input === "number") {
      writeAll(kernelFs, input, bytes);
      if (normalized.flush) kernelFs.sync(input, false);
      return;
    }
    const fd = openFd(
      kernelFs,
      input,
      parseOpenFlags(normalized.flag ?? "a"),
      normalizeMode(normalized.mode),
    );
    try {
      writeAll(kernelFs, fd, bytes);
      if (normalized.flush) kernelFs.sync(fd, false);
    } finally {
      kernelFs.close(fd);
    }
  };
  callFs("appendFile", typeof input === "string" ? input : undefined, operation);
}

export function copyFileSync(
  kernelFs: KernelFileSystem,
  source: string,
  destination: string,
  flags = 0,
): void {
  const exclusive = (flags & 1) !== 0;
  if ((flags & ~3) !== 0) {
    throw callFs(
      "copyfile",
      source,
      () => {
        throw codedError("ENOTSUP", "forced reflink copying is not supported", "copyfile");
      },
      destination,
    );
  }
  callFs(
    "copyfile",
    source,
    () => {
      const sourceFd = openFd(kernelFs, source, parseOpenFlags("r"));
      let destinationFd: number | undefined;
      try {
        const data = readAll(kernelFs, sourceFd);
        destinationFd = openFd(kernelFs, destination, parseOpenFlags(exclusive ? "wx" : "w"));
        writeAll(kernelFs, destinationFd, data);
      } finally {
        kernelFs.close(sourceFd);
        if (destinationFd !== undefined) kernelFs.close(destinationFd);
      }
    },
    destination,
  );
}
