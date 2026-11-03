// @effect-diagnostics nodeBuiltinImport:off - native descriptors must be positioned before spawn duplicates them.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import type { InheritedFd } from "@signalbox/runner-protocol/ExecProtocol";

const SEEK_FILES =
  "import json,os,sys\nfor fd,offset in json.loads(sys.argv[1]): os.lseek(fd,offset,os.SEEK_SET)";

export class RunnerInheritedFdError extends Error {
  override readonly name = "RunnerInheritedFdError";
}

/** The caller closes these handles after native spawn has duplicated them. */
export function withRunnerInheritedFds<T>(
  inheritedFds: readonly InheritedFd[],
  spawn: (stdio: ["pipe", "pipe", "pipe", ...(number | "ignore")[]]) => T,
): T {
  const opened: number[] = [];
  const targets = new Set<number>();
  const offsets: [number, number][] = [];
  const stdio: ["pipe", "pipe", "pipe", ...(number | "ignore")[]] = ["pipe", "pipe", "pipe"];
  try {
    for (const inherited of inheritedFds) {
      if (
        !Number.isSafeInteger(inherited.childFd) ||
        inherited.childFd < 3 ||
        targets.has(inherited.childFd) ||
        inherited.flags !== 0 ||
        !Number.isSafeInteger(inherited.offset) ||
        inherited.offset < 0
      )
        throw new RunnerInheritedFdError("Invalid inherited read-only file mapping");
      targets.add(inherited.childFd);
      try {
        // NONBLOCK lets us reject a FIFO without blocking the Runner while opening it.
        const fd = NodeFS.openSync(
          inherited.path,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
        );
        opened.push(fd);
        if (!NodeFS.fstatSync(fd).isFile()) throw new Error("Not a regular file");
        if (inherited.offset !== 0) offsets.push([opened.length + 2, inherited.offset]);
        while (stdio.length <= inherited.childFd) stdio.push("ignore");
        stdio[inherited.childFd] = fd;
      } catch (cause) {
        throw new RunnerInheritedFdError(
          `Cannot reopen inherited fd ${inherited.childFd} (${inherited.path})`,
          { cause },
        );
      }
    }
    if (offsets.length > 0) {
      // Node has no lseek. Python is installed on Runner images, and dup'd fds share
      // their OS open-file description, so seeking in this helper positions our handles.
      const result = NodeChildProcess.spawnSync(
        "/usr/bin/python3",
        ["-c", SEEK_FILES, JSON.stringify(offsets)],
        {
          stdio: ["ignore", "ignore", "pipe", ...opened],
          timeout: 5_000,
        },
      );
      if (result.error || result.status !== 0) {
        throw new RunnerInheritedFdError(
          `Cannot seek inherited files: ${result.error?.message ?? result.stderr?.toString().trim()}`,
          { cause: result.error },
        );
      }
    }
    return spawn(stdio);
  } finally {
    for (const fd of opened) NodeFS.closeSync(fd);
  }
}
