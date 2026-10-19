/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type * as NodeBuffer from "node:buffer";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { unsupportedFs } from "./errors.ts";
import { statfsSync } from "./sync.ts";
import type { appendFileSync, readFileSync, writeFileSync } from "./files.ts";
import type { mkdirSync, mkdtempSync, readdirSync, rmSync } from "./directories.ts";
import type { realpathSync, readlinkSync, TimeLike } from "./metadata-ops.ts";
import { pathString, type PathLike } from "./path.ts";
import { normalizeMode, parseOpenFlags } from "./constants.ts";
import { NodeFileHandle } from "./file-handle.ts";
import { createAsyncOperations } from "./async-operations.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { NodeFsDir } from "./directory.ts";
import { createNodeFsGlob } from "./glob.ts";

export interface OpenDirectoryOptions {
  encoding?: BufferEncoding | "buffer";
  bufferSize?: number;
  recursive?: boolean;
}

export function createPromisesApi(kernelFs: KernelFileSystem, runLeaf?: AsyncLeafRunner) {
  const operations = createAsyncOperations(kernelFs, runLeaf);
  return {
    glob: createNodeFsGlob(kernelFs, runLeaf),
    async access(path: PathLike, mode = 0): Promise<void> {
      await operations.access(path, mode);
    },
    async appendFile(
      path: PathLike | NodeFileHandle | number,
      data: string | ArrayBuffer | ArrayBufferView,
      options?: BufferEncoding | Parameters<typeof appendFileSync>[3],
    ): Promise<void> {
      if (path instanceof NodeFileHandle) await path.appendFile(data, options ?? undefined);
      else await operations.appendFile(path, data, options);
    },
    async chmod(path: PathLike, _mode: number): Promise<void> {
      throw unsupportedFs("chmod", pathString(path));
    },
    async copyFile(source: PathLike, destination: PathLike, flags = 0): Promise<void> {
      await operations.copyFile(pathString(source), pathString(destination), flags);
    },
    async link(existingPath: PathLike, newPath: PathLike): Promise<void> {
      await operations.link(existingPath, newPath);
    },
    async lstat(path: PathLike, options?: { bigint?: boolean }) {
      return await operations.lstat(path, options);
    },
    async lutimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
      await operations.utimes(path, atime, mtime, false);
    },
    async mkdir(
      path: PathLike,
      options?: number | Parameters<typeof mkdirSync>[2],
    ): Promise<string | undefined> {
      return await operations.mkdir(path, options);
    },
    async mkdtemp(
      prefix: PathLike,
      options?: BufferEncoding | Parameters<typeof mkdtempSync>[2],
    ): Promise<string | NodeBuffer.Buffer> {
      return await operations.mkdtemp(prefix, options);
    },
    async open(
      path: PathLike,
      flags: string | number = "r",
      mode?: number,
    ): Promise<NodeFileHandle> {
      const name = pathString(path);
      const fd = await operations.openFd(name, parseOpenFlags(flags), normalizeMode(mode));
      return new NodeFileHandle(kernelFs, fd, name, runLeaf);
    },
    async opendir(path: PathLike, options: OpenDirectoryOptions = {}): Promise<NodeFsDir> {
      if (options.recursive) throw unsupportedFs("opendir", pathString(path));
      const entries = await operations.readdir(path, { ...options, withFileTypes: true });
      return new NodeFsDir(path, entries as import("./metadata.ts").NodeDirentLike[]);
    },
    async readFile(
      path: PathLike | NodeFileHandle | number,
      options?: BufferEncoding | Parameters<typeof readFileSync>[2],
    ): Promise<NodeBuffer.Buffer | string> {
      return path instanceof NodeFileHandle
        ? path.readFile(options ?? undefined)
        : operations.readFile(path, options);
    },
    async readdir(
      path: PathLike,
      options?: BufferEncoding | Parameters<typeof readdirSync>[2],
    ): Promise<Array<string | NodeBuffer.Buffer | import("./metadata.ts").NodeDirentLike>> {
      return await operations.readdir(path, options);
    },
    async readlink(
      path: PathLike,
      options?: BufferEncoding | Parameters<typeof readlinkSync>[2],
    ): Promise<string | NodeBuffer.Buffer> {
      return await operations.readlink(path, options);
    },
    async realpath(
      path: PathLike,
      options?: BufferEncoding | Parameters<typeof realpathSync>[2],
    ): Promise<string | NodeBuffer.Buffer> {
      return await operations.realpath(path, options);
    },
    async rename(oldPath: PathLike, newPath: PathLike): Promise<void> {
      await operations.rename(oldPath, newPath);
    },
    async rm(path: PathLike, options?: Parameters<typeof rmSync>[2]): Promise<void> {
      await operations.rm(path, options);
    },
    async rmdir(path: PathLike, options?: { recursive?: boolean }): Promise<void> {
      if (options?.recursive) await operations.rm(path, { recursive: true });
      else await operations.rmdir(path);
    },
    async stat(path: PathLike, options?: { bigint?: boolean }) {
      return await operations.stat(path, options);
    },
    async statfs(path: PathLike): Promise<never> {
      return statfsSync(path);
    },
    async symlink(target: PathLike, path: PathLike, type?: string): Promise<void> {
      await operations.symlink(target, path, type);
    },
    async unlink(path: PathLike): Promise<void> {
      await operations.unlink(path);
    },
    async utimes(path: PathLike, atime: TimeLike, mtime: TimeLike): Promise<void> {
      await operations.utimes(path, atime, mtime);
    },
    async writeFile(
      path: PathLike | NodeFileHandle | number,
      data: string | ArrayBuffer | ArrayBufferView,
      options?: BufferEncoding | Parameters<typeof writeFileSync>[3],
    ): Promise<void> {
      if (path instanceof NodeFileHandle) await path.writeFile(data, options ?? undefined);
      else await operations.writeFile(path, data, options);
    },
  };
}
