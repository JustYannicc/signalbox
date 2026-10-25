/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - Node fs needs POSIX path traversal and random temporary directory names.
import type * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { codedError } from "./errors.ts";
import { fsOperation, leaf, runSync, type FsOperation } from "./operations.ts";
import { parsePermissionMode } from "./permission-ops.ts";
import { encodedPath, nodeDirent, type NodeDirentLike } from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";

export interface ReaddirOptions {
  encoding?: BufferEncoding | "buffer";
  withFileTypes?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number | string;
}

function parseReaddirOptions(options?: BufferEncoding | ReaddirOptions | null): ReaddirOptions {
  return typeof options === "string" ? { encoding: options } : (options ?? {});
}

function appendChildPath(parent: string, child: string): string {
  if (parent === "") return child;
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

export function* readdirOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: BufferEncoding | ReaddirOptions | null,
): FsOperation<Array<string | NodeBuffer.Buffer | NodeDirentLike>> {
  const name = pathString(path);
  const normalized = parseReaddirOptions(options);
  const encoding = normalized.encoding ?? "utf8";
  return yield* fsOperation(
    "scandir",
    name,
    (function* (): FsOperation<Array<string | NodeBuffer.Buffer | NodeDirentLike>> {
      const names = yield* leaf(() => kernelFs.readdir(name));
      const entries: Array<string | NodeBuffer.Buffer | NodeDirentLike> = [];
      for (const entryName of names) {
        if (!normalized.withFileTypes) entries.push(encodedPath(entryName, encoding));
        else {
          const entryPath = appendChildPath(name, entryName);
          const type = (yield* leaf(() => kernelFs.lstat(entryPath))).type;
          entries.push(nodeDirent({ name: entryName, type }, name, encoding));
        }
      }
      return entries;
    })(),
  );
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function* mkdirRecursive(
  kernelFs: KernelFileSystem,
  path: string,
  mode: number,
): FsOperation<string | undefined> {
  if (path.length === 0) throw codedError("ENOENT", "no such file or directory", "mkdir");
  const absolute = NodePath.posix.isAbsolute(path);
  let current = absolute ? "/" : "";
  let firstCreated: string | undefined;
  const components = path.split("/").filter((part) => part !== "");

  for (const component of components) {
    current =
      current === "/" ? `/${component}` : current === "" ? component : `${current}/${component}`;
    try {
      if ((yield* leaf(() => kernelFs.stat(current))).type !== "directory") {
        throw codedError("ENOTDIR", "not a directory", "mkdir");
      }
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      yield* leaf(() => kernelFs.mkdir(current, mode));
      firstCreated ??= current;
    }
  }

  if (current === "") current = ".";
  if (components.length === 0 && (yield* leaf(() => kernelFs.stat(current))).type !== "directory") {
    throw codedError("ENOTDIR", "not a directory", "mkdir");
  }

  return firstCreated;
}

export function* mkdirOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: number | MkdirOptions,
): FsOperation<string | undefined> {
  const name = pathString(path);
  const normalized = typeof options === "number" ? { mode: options } : (options ?? {});
  const mode = normalized.mode === undefined ? 0o777 : parsePermissionMode(normalized.mode);
  if (normalized.mode !== undefined && kernelFs.posixPolicy === undefined) {
    throw Object.assign(codedError("ENOTSUP", "filesystem permissions are not modeled", "mkdir"), {
      path: name,
    });
  }
  if (normalized.recursive)
    return yield* fsOperation("mkdir", name, mkdirRecursive(kernelFs, name, mode));
  yield* fsOperation(
    "mkdir",
    name,
    leaf(() => kernelFs.mkdir(name, mode)),
  );
  return undefined;
}

export function* rmdirOperation(kernelFs: KernelFileSystem, path: PathLike): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation(
    "rmdir",
    name,
    leaf(() => kernelFs.rmdir(name)),
  );
}

export function* unlinkOperation(kernelFs: KernelFileSystem, path: PathLike): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation(
    "unlink",
    name,
    leaf(() => kernelFs.unlink(name)),
  );
}

export function* renameOperation(
  kernelFs: KernelFileSystem,
  oldPath: PathLike,
  newPath: PathLike,
): FsOperation<void> {
  const source = pathString(oldPath);
  const destination = pathString(newPath);
  yield* fsOperation(
    "rename",
    source,
    leaf(() => kernelFs.rename(source, destination)),
    destination,
  );
}

export function* linkOperation(
  kernelFs: KernelFileSystem,
  existingPath: PathLike,
  newPath: PathLike,
): FsOperation<void> {
  const source = pathString(existingPath);
  const destination = pathString(newPath);
  yield* fsOperation(
    "link",
    source,
    leaf(() => kernelFs.link(source, destination)),
    destination,
  );
}

export function* symlinkOperation(
  kernelFs: KernelFileSystem,
  target: PathLike,
  path: PathLike,
  _type?: string,
): FsOperation<void> {
  const targetName = pathString(target);
  const name = pathString(path);
  yield* fsOperation(
    "symlink",
    name,
    leaf(() => kernelFs.symlink(targetName, name)),
  );
}

export function* rmOperation(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options: { force?: boolean; recursive?: boolean } = {},
): FsOperation<void> {
  const name = pathString(path);
  const remove = function* (target: string): FsOperation<void> {
    let stat;
    try {
      stat = yield* leaf(() => kernelFs.lstat(target));
    } catch (error) {
      if (options.force && codeOf(error) === "ENOENT") return;
      throw error;
    }
    if (stat.type === "directory") {
      if (options.recursive) {
        for (const entryName of yield* leaf(() => kernelFs.readdir(target)))
          yield* remove(appendChildPath(target, entryName));
        yield* leaf(() => kernelFs.rmdir(target));
        return;
      }
      throw codedError("EISDIR", "is a directory", "rm");
    }
    yield* leaf(() => kernelFs.unlink(target));
  };
  yield* fsOperation("rm", name, remove(name));
}

export function* mkdtempOperation(
  kernelFs: KernelFileSystem,
  prefix: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" },
): FsOperation<string | NodeBuffer.Buffer> {
  const base = pathString(prefix);
  const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${base}${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    try {
      yield* fsOperation(
        "mkdtemp",
        base,
        leaf(() => kernelFs.mkdir(candidate)),
      );
      const created = candidate;
      return encodedPath(created, encoding);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
  }
  throw Object.assign(
    codedError("EEXIST", "Unable to create a unique temporary directory", "mkdtemp"),
    { path: base },
  );
}

export const readdirSync = (...args: Parameters<typeof readdirOperation>) =>
  runSync(readdirOperation(...args));

export const mkdirSync = (...args: Parameters<typeof mkdirOperation>) =>
  runSync(mkdirOperation(...args));

export const rmdirSync = (...args: Parameters<typeof rmdirOperation>) =>
  runSync(rmdirOperation(...args));

export const unlinkSync = (...args: Parameters<typeof unlinkOperation>) =>
  runSync(unlinkOperation(...args));

export const renameSync = (...args: Parameters<typeof renameOperation>) =>
  runSync(renameOperation(...args));

export const linkSync = (...args: Parameters<typeof linkOperation>) =>
  runSync(linkOperation(...args));

export const symlinkSync = (...args: Parameters<typeof symlinkOperation>) =>
  runSync(symlinkOperation(...args));

export const rmSync = (...args: Parameters<typeof rmOperation>) => runSync(rmOperation(...args));

export const mkdtempSync = (...args: Parameters<typeof mkdtempOperation>) =>
  runSync(mkdtempOperation(...args));
