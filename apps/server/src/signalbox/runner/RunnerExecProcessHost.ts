// @effect-diagnostics nodeBuiltinImport:off - native process cwd and spawn are a Runner boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePathPosix from "node:path/posix";

import type { ExecCommand } from "@signalbox/runner-protocol/ExecProtocol";

export type RunnerExecStartCommand = Extract<ExecCommand, { readonly type: "start" }>;

export type WorkingDirectoryResult =
  | { readonly _tag: "ready"; readonly cwd: string }
  | { readonly _tag: "workspace_not_ready" }
  | { readonly _tag: "invalid_cwd" };

export interface RunnerExecProcessHost {
  readonly resolveWorkingDirectory: (cwd: string) => WorkingDirectoryResult;
  readonly spawn: (
    command: RunnerExecStartCommand,
    cwd: string,
  ) => NodeChildProcess.ChildProcessWithoutNullStreams;
}

interface RunnerExecProcessHostOptions {
  /** Injection points keep the canonical mount check testable without a host `/workspace`. */
  readonly realpath?: (path: string) => string;
  readonly isDirectory?: (path: string) => boolean;
  readonly spawn?: typeof NodeChildProcess.spawn;
}

const CANONICAL_WORKSPACE = "/workspace";

const inside = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`));
};

const isCanonicalWorkspacePath = (cwd: string) =>
  (cwd === CANONICAL_WORKSPACE || cwd.startsWith(`${CANONICAL_WORKSPACE}/`)) &&
  NodePathPosix.normalize(cwd) === cwd &&
  !cwd.includes("\\") &&
  !cwd.split("/").includes("..") &&
  !cwd.includes("\0");

/** Resolves only the OS mount that owns the canonical workspace; it never maps from a Runner path. */
export const makeRunnerExecProcessHost = (
  options: RunnerExecProcessHostOptions = {},
): RunnerExecProcessHost => {
  const realpath = options.realpath ?? NodeFS.realpathSync.native;
  const isDirectory =
    options.isDirectory ?? ((path: string) => NodeFS.statSync(path).isDirectory());
  const spawn = options.spawn ?? NodeChildProcess.spawn;

  return {
    resolveWorkingDirectory(cwd) {
      if (!isCanonicalWorkspacePath(cwd)) return { _tag: "invalid_cwd" };

      let root: string;
      try {
        root = realpath(CANONICAL_WORKSPACE);
        if (root !== CANONICAL_WORKSPACE || !isDirectory(root)) {
          return { _tag: "workspace_not_ready" };
        }
      } catch {
        return { _tag: "workspace_not_ready" };
      }

      try {
        const resolved = realpath(cwd);
        if (!inside(root, resolved) || !isDirectory(resolved)) return { _tag: "invalid_cwd" };
      } catch {
        return { _tag: "invalid_cwd" };
      }

      // Let the OS resolve its canonical mount at spawn time; do not substitute a Runner path.
      return { _tag: "ready", cwd };
    },
    spawn(command, cwd) {
      return spawn(command.executable, command.argv.slice(1), {
        argv0: command.argv[0],
        cwd,
        env: { ...command.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    },
  };
};
