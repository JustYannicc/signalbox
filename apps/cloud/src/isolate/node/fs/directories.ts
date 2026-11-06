/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - Node fs needs POSIX path traversal and random temporary directory names.
import type * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { NodeFsBackend } from "../../NodeFsBackend.ts";
import { codedError } from "./errors.ts";
import { asyncLeaf, fsOperation, runSync, type FsOperation, fileLeaf } from "./operations.ts";
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
  kernelFs: NodeFsBackend,
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
      const names = yield* fileLeaf(kernelFs, "readdir", [name]);
      const entries: Array<string | NodeBuffer.Buffer | NodeDirentLike> = [];
      for (const entryName of names) {
        if (!normalized.withFileTypes) entries.push(encodedPath(entryName, encoding));
        else {
          const entryPath = appendChildPath(name, entryName);
          const type = (yield* fileLeaf(kernelFs, "lstat", [entryPath])).type;
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
  kernelFs: NodeFsBackend,
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
      if ((yield* fileLeaf(kernelFs, "stat", [current])).type !== "directory") {
        throw codedError("ENOTDIR", "not a directory", "mkdir");
      }
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      yield* fileLeaf(kernelFs, "mkdir", [current, mode]);
      firstCreated ??= current;
    }
  }

  if (current === "") current = ".";
  if (
    components.length === 0 &&
    (yield* fileLeaf(kernelFs, "stat", [current])).type !== "directory"
  ) {
    throw codedError("ENOTDIR", "not a directory", "mkdir");
  }

  return firstCreated;
}

export function* mkdirOperation(
  kernelFs: NodeFsBackend,
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
  yield* fsOperation("mkdir", name, fileLeaf(kernelFs, "mkdir", [name, mode]));
  return undefined;
}

export function* rmdirOperation(kernelFs: NodeFsBackend, path: PathLike): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation("rmdir", name, fileLeaf(kernelFs, "rmdir", [name]));
}

export function* unlinkOperation(kernelFs: NodeFsBackend, path: PathLike): FsOperation<void> {
  const name = pathString(path);
  yield* fsOperation("unlink", name, fileLeaf(kernelFs, "unlink", [name]));
}

export function* renameOperation(
  kernelFs: NodeFsBackend,
  oldPath: PathLike,
  newPath: PathLike,
  asyncRename = false,
): FsOperation<void> {
  const source = pathString(oldPath);
  const destination = pathString(newPath);
  yield* fsOperation(
    "rename",
    source,
    asyncRename
      ? asyncLeaf((signal) =>
          kernelFs.asynchronous === undefined
            ? kernelFs.renameAsync(source, destination, signal)
            : kernelFs.asynchronous("rename", [source, destination], signal),
        )
      : fileLeaf(kernelFs, "rename", [source, destination]),
    destination,
  );
}

export function* linkOperation(
  kernelFs: NodeFsBackend,
  existingPath: PathLike,
  newPath: PathLike,
): FsOperation<void> {
  const source = pathString(existingPath);
  const destination = pathString(newPath);
  yield* fsOperation(
    "link",
    source,
    fileLeaf(kernelFs, "link", [source, destination]),
    destination,
  );
}

export function* symlinkOperation(
  kernelFs: NodeFsBackend,
  target: PathLike,
  path: PathLike,
  _type?: string,
): FsOperation<void> {
  const targetName = pathString(target);
  const name = pathString(path);
  yield* fsOperation(
    "symlink",
    targetName,
    fileLeaf(kernelFs, "symlink", [targetName, name]),
    name,
  );
}

export function* rmOperation(
  kernelFs: NodeFsBackend,
  path: PathLike,
  options: { force?: boolean; recursive?: boolean } = {},
): FsOperation<void> {
  const name = pathString(path);
  const remove = function* (target: string): FsOperation<void> {
    let stat;
    try {
      stat = yield* fileLeaf(kernelFs, "lstat", [target]);
    } catch (error) {
      if (options.force && codeOf(error) === "ENOENT") return;
      throw error;
    }
    if (stat.type === "directory") {
      if (options.recursive) {
        for (const entryName of yield* fileLeaf(kernelFs, "readdir", [target]))
          yield* remove(appendChildPath(target, entryName));
        yield* fileLeaf(kernelFs, "rmdir", [target]);
        return;
      }
      throw codedError("EISDIR", "is a directory", "rm");
    }
    yield* fileLeaf(kernelFs, "unlink", [target]);
  };
  yield* fsOperation("rm", name, remove(name));
}

export function* mkdtempOperation(
  kernelFs: NodeFsBackend,
  prefix: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" },
): FsOperation<string | NodeBuffer.Buffer> {
  const base = pathString(prefix);
  const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${base}${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    try {
      yield* fsOperation("mkdtemp", base, fileLeaf(kernelFs, "mkdir", [candidate]));
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
