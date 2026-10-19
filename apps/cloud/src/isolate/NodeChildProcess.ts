import type { KernelProgramHost } from "../kernel/KernelProgramHost.ts";

import { unsupportedNodeOperation } from "./node/process/NodeError.ts";
import {
  NodeChildProcess,
  type NodeChildProcessContext,
  type NodeChildProcessWithPipes,
} from "./node/childProcess/ChildProcess.ts";
import {
  isArgumentList,
  normalizeShellCommand,
  normalizeSpawn,
  type NodeChildProcessDefaults,
  type NodeChildProcessOptions,
  type NodeExecOptions,
  type NodeSyncOptions,
} from "./node/childProcess/arguments.ts";
import {
  createExecMethods,
  type ChildProcessSpawner,
  type ExecCallback,
} from "./node/childProcess/exec.ts";
import { createSyncMethods } from "./node/childProcess/sync.ts";
import { resolveGuestExecutable } from "./node/childProcess/resolveExecutable.ts";

/* Adapted from Rivet agentOS's child_process bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Signalbox keeps shell composition and callback semantics while the process host owns admission and I/O.
 * Licensed under Apache-2.0; see ./bun/LICENSE.agentos and ./bun/NOTICE.agentos.
 */

export { NodeChildProcess as ChildProcess, NodeChildProcess };
export type { NodeChildProcessWithPipes };
export type { NodeChildProcessOptions, NodeExecOptions, NodeSyncOptions, ExecCallback };
export type { NodeChildProcessContext };

type DefaultPipedNodeChildProcessOptions = NodeChildProcessOptions & {
  readonly stdio?: "pipe" | null | undefined;
};

export function createNodeChildProcess(host: KernelProgramHost, process: NodeChildProcessContext) {
  if (
    !host ||
    typeof host.prepare !== "function" ||
    typeof host.preparePiped !== "function" ||
    typeof host.resolve !== "function" ||
    typeof host.backend !== "function" ||
    typeof host.exitStatus !== "function" ||
    typeof host.reap !== "function" ||
    typeof host.runInline !== "function" ||
    typeof host.processes?.info !== "function" ||
    typeof host.processes.signalPid !== "function"
  ) {
    throw new TypeError("child_process requires the kernel program host");
  }
  if (!process || !process.env || typeof process.filesystem?.cwd !== "string") {
    throw new TypeError("child_process requires the current process environment and cwd");
  }

  const defaults: NodeChildProcessDefaults = {
    env: process.env,
    cwd: () => process.filesystem.cwd,
  };

  function spawn(
    file: string,
    options?: DefaultPipedNodeChildProcessOptions,
  ): NodeChildProcessWithPipes;
  function spawn(file: string, options: NodeChildProcessOptions): NodeChildProcess;
  function spawn(file: string, args: readonly string[]): NodeChildProcessWithPipes;
  function spawn(
    file: string,
    args: readonly string[],
    options?: DefaultPipedNodeChildProcessOptions,
  ): NodeChildProcessWithPipes;
  function spawn(
    file: string,
    args: readonly string[],
    options: NodeChildProcessOptions,
  ): NodeChildProcess;
  function spawn(
    file: string,
    argsOrOptions?: readonly string[] | NodeChildProcessOptions,
    options?: NodeChildProcessOptions,
  ): NodeChildProcess {
    const [args, spawnOptions] = parseSpawnArguments(argsOrOptions, options);
    const normalized = normalizeSpawn(file, args, spawnOptions, defaults);
    const resolution = resolveGuestExecutable(host, normalized.spawnfile, {
      cwd: normalized.cwd,
      baseCwd: defaults.cwd(),
      PATH: normalized.env.PATH,
    });
    return startChild({ ...normalized, executable: resolution.executable });
  }

  function spawnShell(command: string, options: NodeChildProcessOptions): NodeChildProcess {
    const normalized = normalizeShellCommand(command, options, defaults);
    return startChild(normalized);
  }

  function startChild(normalized: ReturnType<typeof normalizeSpawn>): NodeChildProcess {
    const child = new NodeChildProcess(host, process, normalized);
    child.start();
    return child;
  }

  const execSpawner: ChildProcessSpawner = (file, argsOrOptions, options) =>
    isArgumentList(argsOrOptions)
      ? spawn(file, argsOrOptions, options ?? {})
      : spawn(file, argsOrOptions ?? {});
  const asyncMethods = createExecMethods(execSpawner, spawnShell);
  const syncMethods = createSyncMethods(host, process, defaults);
  const fork = (..._args: unknown[]): never => unsupportedNodeOperation("child_process.fork IPC");

  return Object.freeze({
    ChildProcess: NodeChildProcess,
    spawn,
    exec: asyncMethods.exec,
    execFile: asyncMethods.execFile,
    spawnSync: syncMethods.spawnSync,
    execSync: syncMethods.execSync,
    execFileSync: syncMethods.execFileSync,
    fork,
  });
}

function parseSpawnArguments(
  argsOrOptions: readonly string[] | NodeChildProcessOptions | undefined,
  options: NodeChildProcessOptions | undefined,
): [readonly string[], NodeChildProcessOptions] {
  if (isArgumentList(argsOrOptions)) return [argsOrOptions, options ?? {}];
  if (argsOrOptions === undefined) return [[], options ?? {}];
  if (
    argsOrOptions !== undefined &&
    (typeof argsOrOptions !== "object" || argsOrOptions === null)
  ) {
    throw new TypeError('The "options" argument must be an object');
  }
  if (options !== undefined) throw new TypeError("Too many arguments");
  return [[], argsOrOptions ?? {}];
}

export default createNodeChildProcess;
