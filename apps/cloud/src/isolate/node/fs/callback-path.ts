/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { unsupportedFs } from "./errors.ts";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "./directories.ts";
import {
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  utimesSync,
  type TimeLike,
} from "./metadata-ops.ts";
import { pathString, type PathLike } from "./path.ts";
import { schedule, type FsCallback } from "./callback-utils.ts";

export function createPathCallbackApi(kernelFs: KernelFileSystem) {
  return {
    stat: (
      path: PathLike,
      optionsOrCallback: { bigint?: boolean } | FsCallback<[ReturnType<typeof statSync>]>,
      optionalCallback?: FsCallback<[ReturnType<typeof statSync>]>,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[ReturnType<typeof statSync>]>(
        callback,
        () => [statSync(kernelFs, path, options)],
        "stat",
        name,
      );
    },
    lstat: (
      path: PathLike,
      optionsOrCallback: { bigint?: boolean } | FsCallback<[ReturnType<typeof lstatSync>]>,
      optionalCallback?: FsCallback<[ReturnType<typeof lstatSync>]>,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[ReturnType<typeof lstatSync>]>(
        callback,
        () => [lstatSync(kernelFs, path, options)],
        "lstat",
        name,
      );
    },
    readdir: (
      path: PathLike,
      optionsOrCallback:
        | BufferEncoding
        | Parameters<typeof readdirSync>[2]
        | FsCallback<[Array<string | NodeBuffer.Buffer | import("./metadata.ts").NodeDirentLike>]>,
      optionalCallback?: FsCallback<
        [Array<string | NodeBuffer.Buffer | import("./metadata.ts").NodeDirentLike>]
      >,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[ReturnType<typeof readdirSync>]>(
        callback,
        () => [readdirSync(kernelFs, path, options)],
        "scandir",
        name,
      );
    },
    readlink: (
      path: PathLike,
      optionsOrCallback:
        | BufferEncoding
        | Parameters<typeof readlinkSync>[2]
        | FsCallback<[string | NodeBuffer.Buffer]>,
      optionalCallback?: FsCallback<[string | NodeBuffer.Buffer]>,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[ReturnType<typeof readlinkSync>]>(
        callback,
        () => [readlinkSync(kernelFs, path, options)],
        "readlink",
        name,
      );
    },
    realpath: (
      path: PathLike,
      optionsOrCallback:
        | BufferEncoding
        | Parameters<typeof realpathSync>[2]
        | FsCallback<[string | NodeBuffer.Buffer]>,
      optionalCallback?: FsCallback<[string | NodeBuffer.Buffer]>,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[ReturnType<typeof realpathSync>]>(
        callback,
        () => [realpathSync(kernelFs, path, options)],
        "realpath",
        name,
      );
    },
    rename: (from: PathLike, to: PathLike, callback: FsCallback) => {
      const source = pathString(from);
      const destination = pathString(to);
      schedule<[]>(
        callback,
        () => (renameSync(kernelFs, source, destination), []),
        "rename",
        source,
        destination,
      );
    },
    mkdir: (
      path: PathLike,
      optionsOrCallback:
        | number
        | Parameters<typeof mkdirSync>[2]
        | FsCallback<[string | undefined]>,
      optionalCallback?: FsCallback<[string | undefined]>,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[ReturnType<typeof mkdirSync>]>(
        callback,
        () => [mkdirSync(kernelFs, path, options)],
        "mkdir",
        name,
      );
    },
    mkdtemp: (
      prefix: PathLike,
      optionsOrCallback:
        | BufferEncoding
        | Parameters<typeof mkdtempSync>[2]
        | FsCallback<[string | NodeBuffer.Buffer]>,
      optionalCallback?: FsCallback<[string | NodeBuffer.Buffer]>,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(prefix);
      schedule<[ReturnType<typeof mkdtempSync>]>(
        callback,
        () => [mkdtempSync(kernelFs, prefix, options)],
        "mkdtemp",
        name,
      );
    },
    unlink: (path: PathLike, callback: FsCallback) => {
      const name = pathString(path);
      schedule<[]>(callback, () => (unlinkSync(kernelFs, path), []), "unlink", name);
    },
    rmdir: (path: PathLike, callback: FsCallback) => {
      const name = pathString(path);
      schedule<[]>(callback, () => (rmdirSync(kernelFs, path), []), "rmdir", name);
    },
    rm: (
      path: PathLike,
      optionsOrCallback?: Parameters<typeof rmSync>[2] | FsCallback,
      optionalCallback?: FsCallback,
    ) => {
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
      if (typeof callback !== "function") throw new TypeError("The callback argument is required");
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const name = pathString(path);
      schedule<[]>(callback, () => (rmSync(kernelFs, path, options), []), "rm", name);
    },
    link: (from: PathLike, to: PathLike, callback: FsCallback) => {
      const source = pathString(from);
      const destination = pathString(to);
      schedule<[]>(
        callback,
        () => (linkSync(kernelFs, source, destination), []),
        "link",
        source,
        destination,
      );
    },
    symlink: (
      target: PathLike,
      path: PathLike,
      typeOrCallback: string | FsCallback,
      optionalCallback?: FsCallback,
    ) => {
      const callback = typeof typeOrCallback === "function" ? typeOrCallback : optionalCallback;
      if (!callback) throw new TypeError("The callback argument is required");
      const type = typeof typeOrCallback === "string" ? typeOrCallback : undefined;
      const name = pathString(path);
      schedule<[]>(
        callback,
        () => (symlinkSync(kernelFs, target, path, type), []),
        "symlink",
        name,
      );
    },
    utimes: (path: PathLike, atime: TimeLike, mtime: TimeLike, callback: FsCallback) => {
      const name = pathString(path);
      schedule<[]>(callback, () => (utimesSync(kernelFs, path, atime, mtime), []), "utimes", name);
    },
    chmod: (path: PathLike, _mode: number, callback: FsCallback) => {
      const name = pathString(path);
      schedule<[]>(
        callback,
        () => {
          throw unsupportedFs("chmod", name);
        },
        "chmod",
        name,
      );
    },
  };
}
