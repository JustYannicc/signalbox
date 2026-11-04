// @effect-diagnostics nodeBuiltinImport:off - maps a test Drive mount onto owned native temporary files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { RunnerInheritedFileSystem } from "./RunnerInheritedFds.ts";

export function driveFileSystem(root: string): RunnerInheritedFileSystem {
  const canonicalRoot = NodeFS.realpathSync(root);
  const native = (path: string) => NodePath.join(root, NodePath.posix.relative("/workspace", path));
  const openedPaths = new Map<number, string>();
  return {
    realpath(path) {
      const resolved = NodeFS.realpathSync(native(path));
      const relative = NodePath.relative(canonicalRoot, resolved);
      return relative === ".." || relative.startsWith(`..${NodePath.sep}`)
        ? resolved
        : NodePath.posix.join("/workspace", relative);
    },
    stat: (path) => NodeFS.statSync(native(path)),
    open(path, flags) {
      const fd = NodeFS.openSync(native(path), flags);
      openedPaths.set(fd, path);
      return fd;
    },
    readlink(path) {
      const fd = Number(path.slice("/proc/self/fd/".length));
      const openedPath = openedPaths.get(fd);
      if (openedPath === undefined) throw new Error("Unknown test file descriptor");
      return openedPath;
    },
    fstat: NodeFS.fstatSync,
    close(fd) {
      openedPaths.delete(fd);
      NodeFS.closeSync(fd);
    },
  };
}
