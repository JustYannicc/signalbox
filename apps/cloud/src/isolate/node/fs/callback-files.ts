/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { createAsyncOperations } from "./async-operations.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import type { appendFileSync, readFileSync, writeFileSync } from "./files.ts";
import { pathString, type PathOrFd } from "./path.ts";
import { schedule, type FsCallback } from "./callback-utils.ts";

export function createFileCallbackApi(kernelFs: KernelFileSystem, runLeaf?: AsyncLeafRunner) {
  const operations = createAsyncOperations(kernelFs, runLeaf);
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
      async () => [await operations.readFile(path, options)],
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
      async () => (await operations.writeFile(path, data, options), []),
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
      async () => (await operations.appendFile(path, data, options), []),
      "appendFile",
      name,
    );
  }

  return { readFile, writeFile, appendFile };
}
