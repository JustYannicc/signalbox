// @effect-diagnostics nodeBuiltinImport:off - use pure path string utilities and supply session cwd explicitly.
import * as NodePath from "node:path";

import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { NodeSystemError, unsupportedNodeOperation } from "./node/process/NodeError.ts";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";
import { declaredPathFunctions } from "./node/path/capabilities.ts";

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
    ...declaredPathFunctions(NodePath.posix, "posix"),
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
    if (paths.some((path) => windowsDriveRelative.test(path))) {
      unsupportedNodeOperation("path.win32.resolve drive-relative paths");
    }
    // A POSIX guest cwd becomes a root-relative Windows path, as Node does without a drive cwd.
    return NodePath.win32.resolve(cwd, ...paths);
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
    ...declaredPathFunctions(NodePath.win32, "win32"),
    resolve: resolveWin32,
    relative: relativeWin32,
    toNamespacedPath: toNamespacedPathWin32,
  };

  for (const name of ["resolve", "relative"] as const) {
    markNodeBuiltinCapability(posix[name], {
      status: "supported",
      evidence: `NodePath.posix.${name} resolves against the current session filesystem cwd, including changes made by process.chdir.`,
    });
  }
  for (const name of ["resolve", "relative", "toNamespacedPath"] as const) {
    markNodeBuiltinCapability(win32[name], {
      status: "conditional",
      evidence: `NodePath.win32.${name} uses the session cwd and throws ENOTSUP for drive-relative paths because the guest has no per-drive cwd table.`,
    });
  }

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
