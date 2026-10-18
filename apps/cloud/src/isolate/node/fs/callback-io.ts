/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { unsupportedFs } from "./errors.ts";
import { appendFileSync, readFileSync, writeFileSync } from "./files.ts";
import { ioOptions, readSync, writeBufferSync, writeStringSync, type IoOptions } from "./fd-ops.ts";
import { closeFd, openFd } from "./io.ts";
import { fstatSync, fsyncSync } from "./metadata-ops.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import { pathString, type PathLike, type PathOrFd } from "./path.ts";
import { schedule, type FsCallback } from "./callback-utils.ts";

export { type FsCallback } from "./callback-utils.ts";

type WriteCallback =
  | FsCallback<[number, string | ArrayBufferView]>
  | FsCallback<[number, ArrayBufferView]>
  | FsCallback<[number, string]>;

export function createIoCallbackApi(kernelFs: KernelFileSystem) {
  function open(path: PathLike, callback: FsCallback<[number]>): void;
  function open(path: PathLike, flags: string | number, callback: FsCallback<[number]>): void;
  function open(
    path: PathLike,
    flags: string | number,
    mode: number,
    callback: FsCallback<[number]>,
  ): void;
  function open(
    path: PathLike,
    flagsOrCallback: string | number | FsCallback<[number]>,
    modeOrCallback?: number | FsCallback<[number]>,
    optionalCallback?: FsCallback<[number]>,
  ): void {
    const flags = typeof flagsOrCallback === "function" ? "r" : flagsOrCallback;
    const callback =
      typeof flagsOrCallback === "function"
        ? flagsOrCallback
        : typeof modeOrCallback === "function"
          ? modeOrCallback
          : optionalCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    const name = pathString(path);
    const mode =
      typeof flagsOrCallback !== "function" && typeof modeOrCallback === "number"
        ? normalizeMode(modeOrCallback)
        : undefined;
    const parsedFlags = parseOpenFlags(flags);
    schedule<[number]>(callback, () => [openFd(kernelFs, name, parsedFlags, mode)], "open", name);
  }

  function read(
    fd: number,
    buffer: ArrayBufferView,
    callback: FsCallback<[number, ArrayBufferView]>,
  ): void;
  function read(
    fd: number,
    buffer: ArrayBufferView,
    options: IoOptions,
    callback: FsCallback<[number, ArrayBufferView]>,
  ): void;
  function read(
    fd: number,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    callback: FsCallback<[number, ArrayBufferView]>,
  ): void;
  function read(
    fd: number,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
    callback: FsCallback<[number, ArrayBufferView]>,
  ): void;
  function read(
    fd: number,
    buffer: ArrayBufferView,
    offsetOrOptionsOrCallback: number | IoOptions | FsCallback<[number, ArrayBufferView]>,
    lengthOrCallback?: number | FsCallback<[number, ArrayBufferView]>,
    positionOrCallback?: number | null | FsCallback<[number, ArrayBufferView]>,
    optionalCallback?: FsCallback<[number, ArrayBufferView]>,
  ): void {
    const options =
      typeof offsetOrOptionsOrCallback === "object"
        ? offsetOrOptionsOrCallback
        : typeof offsetOrOptionsOrCallback === "number"
          ? ioOptions(
              offsetOrOptionsOrCallback,
              typeof lengthOrCallback === "number" ? lengthOrCallback : undefined,
              typeof positionOrCallback === "number" || positionOrCallback === null
                ? positionOrCallback
                : undefined,
            )
          : undefined;
    const callback =
      typeof offsetOrOptionsOrCallback === "function"
        ? offsetOrOptionsOrCallback
        : typeof lengthOrCallback === "function"
          ? lengthOrCallback
          : typeof positionOrCallback === "function"
            ? positionOrCallback
            : optionalCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    schedule<[number, ArrayBufferView]>(
      callback,
      () => [readSync(kernelFs, fd, buffer, options ?? {}), buffer],
      "read",
    );
  }

  function write(
    fd: number,
    data: string | ArrayBufferView,
    callback: FsCallback<[number, string | ArrayBufferView]>,
  ): void;
  function write(
    fd: number,
    data: string | ArrayBufferView,
    options: IoOptions,
    callback: FsCallback<[number, string | ArrayBufferView]>,
  ): void;
  function write(
    fd: number,
    data: ArrayBufferView,
    offset: number,
    length: number,
    callback: FsCallback<[number, ArrayBufferView]>,
  ): void;
  function write(
    fd: number,
    data: ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
    callback: FsCallback<[number, ArrayBufferView]>,
  ): void;
  function write(
    fd: number,
    data: string,
    position: number | null,
    callback: FsCallback<[number, string]>,
  ): void;
  function write(
    fd: number,
    data: string,
    position: number | null,
    encoding: BufferEncoding,
    callback: FsCallback<[number, string]>,
  ): void;
  function write(
    fd: number,
    data: string | ArrayBufferView,
    offsetOrOptionsOrCallback?: number | null | IoOptions | WriteCallback,
    lengthEncodingOrCallback?: number | BufferEncoding | WriteCallback,
    positionOrCallback?: number | null | WriteCallback,
    optionalCallback?: WriteCallback,
  ): void {
    const callback =
      typeof offsetOrOptionsOrCallback === "function"
        ? offsetOrOptionsOrCallback
        : typeof lengthEncodingOrCallback === "function"
          ? lengthEncodingOrCallback
          : typeof positionOrCallback === "function"
            ? positionOrCallback
            : optionalCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    if (typeof data === "string") {
      const position =
        typeof offsetOrOptionsOrCallback === "number" || offsetOrOptionsOrCallback === null
          ? offsetOrOptionsOrCallback
          : undefined;
      const encoding =
        typeof lengthEncodingOrCallback === "string" ? lengthEncodingOrCallback : "utf8";
      schedule<[number, string]>(
        callback as FsCallback<[number, string]>,
        () => [writeStringSync(kernelFs, fd, data, position, encoding), data],
        "write",
      );
      return;
    }
    const options =
      typeof offsetOrOptionsOrCallback === "object" && offsetOrOptionsOrCallback !== null
        ? offsetOrOptionsOrCallback
        : ioOptions(
            typeof offsetOrOptionsOrCallback === "number" ? offsetOrOptionsOrCallback : 0,
            typeof lengthEncodingOrCallback === "number"
              ? lengthEncodingOrCallback
              : data.byteLength -
                  (typeof offsetOrOptionsOrCallback === "number" ? offsetOrOptionsOrCallback : 0),
            typeof positionOrCallback === "number" || positionOrCallback === null
              ? positionOrCallback
              : undefined,
          );
    schedule<[number, ArrayBufferView]>(
      callback as FsCallback<[number, ArrayBufferView]>,
      () => [writeBufferSync(kernelFs, fd, data, options), data],
      "write",
    );
  }

  function readFile(path: PathOrFd, callback: FsCallback<[NodeBuffer.Buffer | string]>): void;
  function readFile(
    path: PathOrFd,
    options: BufferEncoding | Parameters<typeof readFileSync>[2],
    callback: FsCallback<[NodeBuffer.Buffer | string]>,
  ): void;
  function readFile(
    path: PathOrFd,
    optionsOrCallback:
      | BufferEncoding
      | Parameters<typeof readFileSync>[2]
      | FsCallback<[NodeBuffer.Buffer | string]>,
    optionalCallback?: FsCallback<[NodeBuffer.Buffer | string]>,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    const name = typeof path === "number" ? undefined : pathString(path);
    schedule<[NodeBuffer.Buffer | string]>(
      callback,
      () => [readFileSync(kernelFs, path, options)],
      "readFile",
      name,
    );
  }

  function writeFile(
    path: PathOrFd,
    data: string | ArrayBuffer | ArrayBufferView,
    callback: FsCallback,
  ): void;
  function writeFile(
    path: PathOrFd,
    data: string | ArrayBuffer | ArrayBufferView,
    options: BufferEncoding | Parameters<typeof writeFileSync>[3],
    callback: FsCallback,
  ): void;
  function writeFile(
    path: PathOrFd,
    data: string | ArrayBuffer | ArrayBufferView,
    optionsOrCallback: BufferEncoding | Parameters<typeof writeFileSync>[3] | FsCallback,
    optionalCallback?: FsCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    const name = typeof path === "number" ? undefined : pathString(path);
    schedule<[]>(
      callback,
      () => (writeFileSync(kernelFs, path, data, options), []),
      "writeFile",
      name,
    );
  }

  function appendFile(
    path: PathOrFd,
    data: string | ArrayBuffer | ArrayBufferView,
    callback: FsCallback,
  ): void;
  function appendFile(
    path: PathOrFd,
    data: string | ArrayBuffer | ArrayBufferView,
    options: BufferEncoding | Parameters<typeof appendFileSync>[3],
    callback: FsCallback,
  ): void;
  function appendFile(
    path: PathOrFd,
    data: string | ArrayBuffer | ArrayBufferView,
    optionsOrCallback: BufferEncoding | Parameters<typeof appendFileSync>[3] | FsCallback,
    optionalCallback?: FsCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    const name = typeof path === "number" ? undefined : pathString(path);
    schedule<[]>(
      callback,
      () => (appendFileSync(kernelFs, path, data, options), []),
      "appendFile",
      name,
    );
  }

  function close(fd: number, callback: FsCallback): void {
    schedule<[]>(callback, () => (closeFd(kernelFs, fd), []), "close");
  }

  function fstat(
    fd: number,
    optionsOrCallback: { bigint?: boolean } | FsCallback<[ReturnType<typeof fstatSync>]>,
    optionalCallback?: FsCallback<[ReturnType<typeof fstatSync>]>,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    if (!callback) throw new TypeError("The callback argument is required");
    schedule<[ReturnType<typeof fstatSync>]>(
      callback,
      () => [fstatSync(kernelFs, fd, options)],
      "fstat",
    );
  }

  return {
    open,
    close,
    read,
    write,
    readFile,
    writeFile,
    appendFile,
    fstat,
    fsync: (fd: number, callback: FsCallback) =>
      schedule<[]>(callback, () => (fsyncSync(kernelFs, fd), []), "fsync"),
    fchown: (_fd: number, _uid: number, _gid: number, callback: FsCallback) =>
      schedule<[]>(
        callback,
        () => {
          throw unsupportedFs("fchown");
        },
        "fchown",
      ),
    fchmod: (_fd: number, _mode: number, callback: FsCallback) =>
      schedule<[]>(
        callback,
        () => {
          throw unsupportedFs("fchmod");
        },
        "fchmod",
      ),
  };
}
