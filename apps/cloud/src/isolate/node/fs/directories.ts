/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
// @effect-diagnostics nodeBuiltinImport:off - Node fs needs POSIX path traversal and random temporary directory names.
import type * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { callFs, codedError } from "./errors.ts";
import {
  encodedPath,
  nodeDirent,
  type KernelDirectoryEntry,
  type NodeDirentLike,
} from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";

export interface ReaddirOptions {
  encoding?: BufferEncoding | "buffer";
  withFileTypes?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

function parseReaddirOptions(options?: BufferEncoding | ReaddirOptions | null): ReaddirOptions {
  return typeof options === "string" ? { encoding: options } : (options ?? {});
}

function appendChildPath(parent: string, child: string): string {
  if (parent === "") return child;
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

export function readdirSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: BufferEncoding | ReaddirOptions | null,
): Array<string | NodeBuffer.Buffer | NodeDirentLike> {
  const name = pathString(path);
  const normalized = parseReaddirOptions(options);
  const encoding = normalized.encoding ?? "utf8";
  return callFs("scandir", name, () =>
    kernelFs.readdir(name).map((entryName) => {
      if (!normalized.withFileTypes) return encodedPath(entryName, encoding);
      const entryPath = appendChildPath(name, entryName);
      const entry: KernelDirectoryEntry = { name: entryName, type: kernelFs.lstat(entryPath).type };
      return nodeDirent(entry, name, encoding);
    }),
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

function mkdirRecursive(kernelFs: KernelFileSystem, path: string): string | undefined {
  if (path.length === 0) throw codedError("ENOENT", "no such file or directory", "mkdir");
  const absolute = NodePath.posix.isAbsolute(path);
  let current = absolute ? "/" : "";
  let firstCreated: string | undefined;
  const components = path.split("/").filter((part) => part !== "");

  for (const component of components) {
    current =
      current === "/" ? `/${component}` : current === "" ? component : `${current}/${component}`;
    try {
      if (kernelFs.stat(current).type !== "directory") {
        throw codedError("ENOTDIR", "not a directory", "mkdir");
      }
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      kernelFs.mkdir(current);
      firstCreated ??= current;
    }
  }

  if (current === "") current = ".";
  if (components.length === 0 && kernelFs.stat(current).type !== "directory") {
    throw codedError("ENOTDIR", "not a directory", "mkdir");
  }

  return firstCreated;
}

export function mkdirSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options?: number | MkdirOptions,
): string | undefined {
  const name = pathString(path);
  const normalized = typeof options === "number" ? { mode: options } : (options ?? {});
  if (normalized.mode !== undefined) {
    throw Object.assign(codedError("ENOTSUP", "filesystem permissions are not modeled", "mkdir"), {
      path: name,
    });
  }
  if (normalized.recursive) return callFs("mkdir", name, () => mkdirRecursive(kernelFs, name));
  callFs("mkdir", name, () => kernelFs.mkdir(name));
  return undefined;
}

export function rmdirSync(kernelFs: KernelFileSystem, path: PathLike): void {
  const name = pathString(path);
  callFs("rmdir", name, () => kernelFs.rmdir(name));
}

export function unlinkSync(kernelFs: KernelFileSystem, path: PathLike): void {
  const name = pathString(path);
  callFs("unlink", name, () => kernelFs.unlink(name));
}

export function renameSync(kernelFs: KernelFileSystem, oldPath: PathLike, newPath: PathLike): void {
  const source = pathString(oldPath);
  const destination = pathString(newPath);
  callFs("rename", source, () => kernelFs.rename(source, destination), destination);
}

export function linkSync(
  kernelFs: KernelFileSystem,
  existingPath: PathLike,
  newPath: PathLike,
): void {
  const source = pathString(existingPath);
  const destination = pathString(newPath);
  callFs("link", source, () => kernelFs.link(source, destination), destination);
}

export function symlinkSync(
  kernelFs: KernelFileSystem,
  target: PathLike,
  path: PathLike,
  _type?: string,
): void {
  const targetName = pathString(target);
  const name = pathString(path);
  callFs("symlink", name, () => kernelFs.symlink(targetName, name));
}

export function rmSync(
  kernelFs: KernelFileSystem,
  path: PathLike,
  options: { force?: boolean; recursive?: boolean } = {},
): void {
  const name = pathString(path);
  const remove = (target: string) => {
    let stat;
    try {
      stat = kernelFs.lstat(target);
    } catch (error) {
      if (options.force && codeOf(error) === "ENOENT") return;
      throw error;
    }
    if (stat.type === "directory") {
      if (options.recursive) {
        for (const entryName of kernelFs.readdir(target))
          remove(appendChildPath(target, entryName));
        kernelFs.rmdir(target);
        return;
      }
      throw codedError("EISDIR", "is a directory", "rm");
    }
    kernelFs.unlink(target);
  };
  callFs("rm", name, () => remove(name));
}

export function mkdtempSync(
  kernelFs: KernelFileSystem,
  prefix: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | "buffer" },
): string | NodeBuffer.Buffer {
  const base = pathString(prefix);
  const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${base}${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    try {
      const created = callFs("mkdtemp", base, () => {
        kernelFs.mkdir(candidate);
        return candidate;
      });
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
