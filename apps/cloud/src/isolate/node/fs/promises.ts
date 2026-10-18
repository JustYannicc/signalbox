/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { unsupportedFs } from "./errors.ts";
import { accessSync, statfsSync } from "./sync.ts";
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "./files.ts";
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
import { openFd } from "./io.ts";
import {
  lstatSync,
  realpathSync,
  readlinkSync,
  statSync,
  utimesSync,
  type TimeLike,
} from "./metadata-ops.ts";
import { pathString, type PathLike } from "./path.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import { NodeFileHandle } from "./file-handle.ts";
import { NodeFsDir } from "./directory.ts";

export interface OpenDirectoryOptions {
  encoding?: BufferEncoding | "buffer";
  bufferSize?: number;
  recursive?: boolean;
}

export function createPromisesApi(kernelFs: KernelFileSystem) {
  return {
    async access(path: PathLike, mode = 0): Promise<void> {
      accessSync(kernelFs, path, mode);
    },
    async appendFile(
      path: PathLike | NodeFileHandle | number,
      data: string | ArrayBuffer | ArrayBufferView,
      options?: BufferEncoding | Parameters<typeof appendFileSync>[3],
    ): Promise<void> {
      appendFileSync(kernelFs, path instanceof NodeFileHandle ? path.fd : path, data, options);
    },
    async chmod(path: PathLike, _mode: number): Promise<void> {
      throw unsupportedFs("chmod", pathString(path));
    },
    async copyFile(source: PathLike, destination: PathLike, flags = 0): Promise<void> {
      copyFileSync(kernelFs, pathString(source), pathString(destination), flags);
    },
    async link(existingPath: PathLike, newPath: PathLike): Promise<void> {
      linkSync(kernelFs, existingPath, newPath);
    },
    async lstat(path: PathLike, options?: { bigint?: boolean }) {
      return lstatSync(kernelFs, path, options);
    },
    async lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
      utimesSync(kernelFs, path, atime, mtime, false);
    },
    async mkdir(
      path: PathLike,
      options?: number | Parameters<typeof mkdirSync>[2],
    ): Promise<string | undefined> {
      return mkdirSync(kernelFs, path, options);
    },
    async mkdtemp(
      prefix: PathLike,
      options?: BufferEncoding | Parameters<typeof mkdtempSync>[2],
    ): Promise<string | NodeBuffer.Buffer> {
      return mkdtempSync(kernelFs, prefix, options);
    },
    async open(
      path: PathLike,
      flags: string | number = "r",
      mode?: number,
    ): Promise<NodeFileHandle> {
      const name = pathString(path);
      const fd = openFd(kernelFs, name, parseOpenFlags(flags), normalizeMode(mode));
      return new NodeFileHandle(kernelFs, fd, name);
    },
    async opendir(path: PathLike, options: OpenDirectoryOptions = {}): Promise<NodeFsDir> {
      if (options.recursive) throw unsupportedFs("opendir", pathString(path));
      return new NodeFsDir(kernelFs, path, options);
    },
    async readFile(
      path: PathLike | NodeFileHandle | number,
      options?: BufferEncoding | Parameters<typeof readFileSync>[2],
    ): Promise<NodeBuffer.Buffer | string> {
      return readFileSync(kernelFs, path instanceof NodeFileHandle ? path.fd : path, options);
    },
    async readdir(
      path: PathLike,
      options?: BufferEncoding | Parameters<typeof readdirSync>[2],
    ): Promise<Array<string | NodeBuffer.Buffer | import("./metadata.ts").NodeDirentLike>> {
      return readdirSync(kernelFs, path, options);
    },
    async readlink(
      path: PathLike,
      options?: BufferEncoding | Parameters<typeof readlinkSync>[2],
    ): Promise<string | NodeBuffer.Buffer> {
      return readlinkSync(kernelFs, path, options);
    },
    async realpath(
      path: PathLike,
      options?: BufferEncoding | Parameters<typeof realpathSync>[2],
    ): Promise<string | NodeBuffer.Buffer> {
      return realpathSync(kernelFs, path, options);
    },
    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
      renameSync(kernelFs, oldPath, newPath);
    },
    async rm(path: PathLike, options?: Parameters<typeof rmSync>[2]): Promise<void> {
      rmSync(kernelFs, path, options);
    },
    async rmdir(path: PathLike, options?: { recursive?: boolean }): Promise<void> {
      if (options?.recursive) rmSync(kernelFs, path, { recursive: true });
      else rmdirSync(kernelFs, path);
    },
    async stat(path: PathLike, options?: { bigint?: boolean }) {
      return statSync(kernelFs, path, options);
    },
    async statfs(path: PathLike): Promise<never> {
      return statfsSync(path);
    },
    async symlink(target: PathLike, path: PathLike, type?: string): Promise<void> {
      symlinkSync(kernelFs, target, path, type);
    },
    async unlink(path: PathLike): Promise<void> {
      unlinkSync(kernelFs, path);
    },
    async utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
      utimesSync(kernelFs, path, atime, mtime);
    },
    async writeFile(
      path: PathLike | NodeFileHandle | number,
      data: string | ArrayBuffer | ArrayBufferView,
      options?: BufferEncoding | Parameters<typeof writeFileSync>[3],
    ): Promise<void> {
      writeFileSync(kernelFs, path instanceof NodeFileHandle ? path.fd : path, data, options);
    },
  };
}
