// @effect-diagnostics nodeBuiltinImport:off - use pure path string utilities and supply session cwd explicitly.
import * as NodePath from "node:path";

import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { NodeSystemError } from "./node/process/NodeError.ts";

export type NodePathFileSystem = Pick<KernelFileSystem, "cwd" | "chdir">;

const windowsDriveRelative = /^([A-Za-z]:)(?![\\/])/;

function assertStringPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (typeof path !== "string") throw new TypeError("Path must be a string");
  }
}

export function createNodePath(filesystem: NodePathFileSystem) {
  if (!filesystem || typeof filesystem.cwd !== "string") {
    throw new TypeError("Node path requires the session filesystem cwd");
  }

  const resolvePosix = (...paths: string[]) => {
    assertStringPaths(paths);
    const cwd = filesystem.cwd;
    if (!NodePath.posix.isAbsolute(cwd)) {
      throw new NodeSystemError(
        "EINVAL",
        "Session cwd must be absolute for path.resolve",
        "resolve",
      );
    }
    return NodePath.posix.resolve(cwd, ...paths);
  };

  const relativePosix = (from: string, to: string) =>
    NodePath.posix.relative(resolvePosix(from), resolvePosix(to));

  const posix = {
    ...NodePath.posix,
    resolve: resolvePosix,
    relative: relativePosix,
  };

  const resolveWin32 = (...paths: string[]) => {
    assertStringPaths(paths);
    const cwd = filesystem.cwd;
    if (!NodePath.posix.isAbsolute(cwd) && !NodePath.win32.isAbsolute(cwd)) {
      throw new NodeSystemError(
        "EINVAL",
        "Session cwd must be absolute for path.resolve",
        "resolve",
      );
    }
    // The host has no per-drive cwd table; drive-relative input is anchored at its drive root.
    const rooted = paths.map((path) => {
      const match = windowsDriveRelative.exec(path);
      return match ? `${match[1]}\\${path.slice(2)}` : path;
    });
    // A POSIX guest cwd becomes a root-relative Windows path, as Node does without a drive cwd.
    return NodePath.win32.resolve(cwd, ...rooted);
  };

  const relativeWin32 = (from: string, to: string) =>
    NodePath.win32.relative(resolveWin32(from), resolveWin32(to));

  const toNamespacedPathWin32 = (path: string) => {
    assertStringPaths([path]);
    const absolutePath = NodePath.win32.isAbsolute(path) ? path : resolveWin32(path);
    return NodePath.win32.toNamespacedPath(absolutePath);
  };

  const win32 = {
    ...NodePath.win32,
    resolve: resolveWin32,
    relative: relativeWin32,
    toNamespacedPath: toNamespacedPathWin32,
  };

  Object.assign(posix, { posix, win32 });
  Object.assign(win32, { posix, win32 });
  Object.freeze(posix);
  Object.freeze(win32);

  return Object.freeze({
    ...posix,
    posix,
    win32,
  });
}

export default createNodePath;
