// @effect-diagnostics nodeBuiltinImport:off - native file handles are opened only within the Runner's Drive mount.
import * as NodeFS from "node:fs";
import * as NodePathPosix from "node:path/posix";
import type { InheritedFd } from "@signalbox/runner-protocol/ExecProtocol";

export interface RunnerInheritedFileSystem {
  readonly realpath: (path: string) => string;
  readonly stat: (path: string) => NodeFS.Stats;
  readonly open: (path: string, flags: number) => number;
  readonly fstat: (fd: number) => NodeFS.Stats;
  readonly close: (fd: number) => void;
}

const nativeFiles: RunnerInheritedFileSystem = {
  realpath: NodeFS.realpathSync.native,
  stat: NodeFS.statSync,
  open: NodeFS.openSync,
  fstat: NodeFS.fstatSync,
  close: NodeFS.closeSync,
};

export class RunnerInheritedFdError extends Error {
  override readonly name = "RunnerInheritedFdError";
  readonly code = "ENOTSUP";
}

/** Closes temporary parent handles once spawn has duplicated them into the child. */
export function withRunnerInheritedFds<T>(
  inheritedFds: readonly InheritedFd[],
  spawn: (stdio: ["pipe", "pipe", "pipe", ...(number | "ignore")[]]) => T,
  files: RunnerInheritedFileSystem = nativeFiles,
): T {
  const opened: number[] = [];
  const targets = new Set<number>();
  const stdio: ["pipe", "pipe", "pipe", ...(number | "ignore")[]] = ["pipe", "pipe", "pipe"];
  try {
    for (const inherited of inheritedFds) {
      if (
        !Number.isSafeInteger(inherited.childFd) ||
        inherited.childFd < 3 ||
        targets.has(inherited.childFd) ||
        inherited.flags !== 0 ||
        inherited.offset !== 0
      ) {
        throw new RunnerInheritedFdError(
          "Only inherited read-only files at offset zero are supported",
        );
      }
      targets.add(inherited.childFd);
      try {
        if (!workspaceFile(inherited.path)) throw new Error("File is outside the Drive workspace");
        const path = files.realpath(inherited.path);
        if (!workspaceFile(path)) throw new Error("File resolves outside the Drive workspace");
        const expected = files.stat(path);
        // NONBLOCK avoids hanging on a FIFO swapped in between stat and open.
        const fd = files.open(
          path,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
        );
        opened.push(fd);
        const actual = files.fstat(fd);
        if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
          throw new Error("Inherited file changed while opening it");
        }
        while (stdio.length <= inherited.childFd) stdio.push("ignore");
        stdio[inherited.childFd] = fd;
      } catch (cause) {
        throw new RunnerInheritedFdError(
          `Cannot reopen inherited fd ${inherited.childFd} (${inherited.path})`,
          { cause },
        );
      }
    }
    return spawn(stdio);
  } finally {
    for (const fd of opened) files.close(fd);
  }
}

function workspaceFile(path: string) {
  return (
    path.startsWith("/workspace/") &&
    NodePathPosix.normalize(path) === path &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}
