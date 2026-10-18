/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { createFileCallbackApi } from "./callback-files.ts";
import { createAsyncOperations } from "./async-operations.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { unsupportedFs } from "./errors.ts";
import { ioOptions, type IoOptions } from "./fd-ops.ts";
import type { fstatSync } from "./metadata-ops.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import { pathString, type PathLike } from "./path.ts";
import { schedule, type FsCallback } from "./callback-utils.ts";

export { type FsCallback } from "./callback-utils.ts";

type WriteCallback =
  | FsCallback<[number, string | ArrayBufferView]>
  | FsCallback<[number, ArrayBufferView]>
  | FsCallback<[number, string]>;

export function createIoCallbackApi(kernelFs: KernelFileSystem, runLeaf?: AsyncLeafRunner) {
  const operations = createAsyncOperations(kernelFs, runLeaf);
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
    schedule<[number]>(
      callback,
      async () => [await operations.openFd(name, parsedFlags, mode)],
      "open",
      name,
    );
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
      async () => [await operations.read(fd, buffer, options ?? {}), buffer],
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
        async () => [await operations.writeString(fd, data, position, encoding), data],
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
      async () => [await operations.writeBuffer(fd, data, options), data],
      "write",
    );
  }

  function close(fd: number, callback: FsCallback): void {
    schedule<[]>(callback, async () => (await operations.closeFd(fd), []), "close");
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
      async () => [await operations.fstat(fd, options)],
      "fstat",
    );
  }

  return {
    open,
    close,
    read,
    write,
    ...createFileCallbackApi(kernelFs, runLeaf),
    fstat,
    fsync: (fd: number, callback: FsCallback) =>
      schedule<[]>(callback, async () => (await operations.fsync(fd), []), "fsync"),
    fchown: (_fd: number, _uid: number, _gid: number, callback: FsCallback) =>
      schedule<[]>(
        callback,
        async () => {
          throw unsupportedFs("fchown");
        },
        "fchown",
      ),
    fchmod: (_fd: number, _mode: number, callback: FsCallback) =>
      schedule<[]>(
        callback,
        async () => {
          throw unsupportedFs("fchmod");
        },
        "fchmod",
      ),
  };
}
