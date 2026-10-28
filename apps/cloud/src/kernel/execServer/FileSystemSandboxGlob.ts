import { RpcError } from "../CodexExecProtocol.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { sandboxErrorCode, sandboxJoin, sandboxParent } from "./FileSystemSandboxPaths.ts";
import { compileSandboxDenyGlobPattern } from "./FileSystemSandboxGlobPattern.ts";

export const MAX_DENY_GLOB_MATCHES = 8192;
export function expandSandboxDenyGlob(
  files: KernelFileSystem,
  absolutePattern: string,
  maxDepth?: number,
): readonly string[] {
  if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 1)) {
    throw new RpcError(-32600, "Invalid glob_scan_max_depth");
  }
  if (!absolutePattern.startsWith("/")) {
    throw new RpcError(-32600, "Filesystem deny glob must be absolute");
  }
  const firstWireGlob = absolutePattern.search(/[*?[\]]/);
  if (firstWireGlob < 0 || absolutePattern.slice(0, firstWireGlob) === "/") {
    throw new RpcError(
      -32600,
      "Unreadable glob cannot be safely expanded; use a pattern with a non-root directory prefix",
    );
  }
  const parsed = compileSandboxDenyGlobPattern(absolutePattern);
  const paths = new Set<string>();
  const add = (path: string, type: string) => {
    paths.add(path);
    if (type === "symlink") {
      try {
        paths.add(files.realpath(path));
      } catch (error) {
        if (sandboxErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (paths.size > MAX_DENY_GLOB_MATCHES) {
      throw new RpcError(-32600, "Filesystem deny glob matched more than 8192 paths");
    }
  };
  if (parsed.firstGlobIndex === undefined) {
    const path = unescapePosixPath(absolutePattern);
    if (!isRealDirectory(files, sandboxParent(path))) return [];
    try {
      const type = files.lstat(path).type;
      if (type === "file" || type === "symlink") add(path, type);
    } catch (error) {
      if (sandboxErrorCode(error) !== "ENOENT") throw error;
    }
    return [...paths].sort();
  }

  const prefix = unescapePosixPath(absolutePattern.slice(0, parsed.firstGlobIndex));
  const end = prefix.endsWith("/") ? prefix.length - 1 : prefix.lastIndexOf("/");
  const root = sandboxJoin("/", end <= 0 ? "/" : prefix.slice(0, end));
  if (prefix === "") {
    throw new RpcError(
      -32600,
      "Unreadable glob cannot be safely expanded; use a pattern with a non-root directory prefix",
    );
  }
  const matcher = parsed.matcher;
  if (!isRealDirectory(files, root)) return [];

  const walk = (directory: string, depth: number): void => {
    for (const name of files.readdir(directory)) {
      const path = sandboxJoin(directory, name);
      let type: string;
      try {
        type = files.lstat(path).type;
      } catch (error) {
        if (sandboxErrorCode(error) === "ENOENT") continue;
        throw error;
      }
      if ((type === "file" || type === "symlink") && matcher.test(path)) add(path, type);
      if (type === "directory" && (maxDepth === undefined || depth < maxDepth)) {
        walk(path, depth + 1);
      }
    }
  };
  walk(root, 1);
  return [...paths].sort();
}

function unescapePosixPath(pattern: string): string {
  let path = "";
  for (let index = 0; index < pattern.length;) {
    const char = String.fromCodePoint(pattern.codePointAt(index)!);
    index += char.length;
    if (char === "\\") {
      const escaped = String.fromCodePoint(pattern.codePointAt(index)!);
      index += escaped.length;
      path += escaped;
    } else {
      path += char;
    }
  }
  return path;
}

function isRealDirectory(files: KernelFileSystem, path: string): boolean {
  let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    current = sandboxJoin(current, part);
    try {
      const type = files.lstat(current).type;
      if (type !== "directory") return false;
    } catch (error) {
      if (sandboxErrorCode(error) === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}
