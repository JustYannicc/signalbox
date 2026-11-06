import type { NodeHarnessBaseInput } from "../NodeHarnessProcess.ts";
import type { ClaudeCliKernelPort } from "../ClaudeCliKernelPort.ts";
import type {
  NodeChildProcessObserver,
  NodeChildProcessOptions,
} from "../../isolate/NodeChildProcess.ts";
import type { NodeChildProcessHandle } from "../../isolate/NodeChildProcessHandle.ts";
import {
  isArgumentList,
  normalizeSpawn,
  normalizeShellCommand,
} from "../../isolate/NodeChildProcessCompatibility.ts";
import { createExecMethods } from "../../isolate/NodeChildProcessCompatibility.ts";
import { unsupportedNodeOperation } from "../../isolate/NodeChildProcessCompatibility.ts";
import { RemoteNodeChild } from "./Child.ts";

export async function createRemoteChildren(input: {
  readonly kernel: ClaudeCliKernelPort;
  readonly process: NodeHarnessBaseInput;
  readonly beforeRemote: () => Promise<void>;
  readonly afterRemote: () => Promise<void>;
  readonly holdDescriptors: (fds: readonly number[]) => () => void;
}) {
  const leases = [...(await input.kernel.leaseProcesses(32))];
  return (signal: AbortSignal, onChild: NodeChildProcessObserver) => {
    const defaults = { env: input.process.env, cwd: () => input.process.computer.files.cwd };
    const start = (spawn: ReturnType<typeof normalizeSpawn>) => {
      const lease = leases.shift();
      if (lease === undefined)
        throw Object.assign(new Error("CLI process leases need asynchronous refill"), {
          code: "EAGAIN",
        });
      // Node duplicates a child's stdio inside spawn(); the CLI may close its copies right after.
      const captured = input.holdDescriptors(
        spawn.stdio.filter((mode): mode is number => typeof mode === "number"),
      );
      const child = new RemoteNodeChild({
        kernel: input.kernel,
        lease,
        spawn,
        signal,
        captured,
        barrier: input.beforeRemote,
        refresh: async (remoteStarted, submitted) => {
          try {
            if (remoteStarted) await input.afterRemote();
          } finally {
            if (!submitted) leases.push(lease);
            else leases.push(...(await input.kernel.leaseProcesses(1)));
          }
        },
      });
      onChild(child, spawn);
      child.start();
      return child;
    };
    type Piped = NodeChildProcessHandle & {
      readonly stdin: import("node:stream").PassThrough;
      readonly stdout: import("node:stream").PassThrough;
      readonly stderr: import("node:stream").PassThrough;
    };
    function spawn(
      file: string,
      args: readonly string[],
      options: NodeChildProcessOptions & { readonly stdio: "pipe" },
    ): Piped;
    function spawn(
      file: string,
      argsOrOptions?: readonly string[] | NodeChildProcessOptions,
      options?: NodeChildProcessOptions,
    ): NodeChildProcessHandle;
    function spawn(
      file: string,
      argsOrOptions?: readonly string[] | NodeChildProcessOptions,
      options?: NodeChildProcessOptions,
    ): NodeChildProcessHandle {
      if (!isArgumentList(argsOrOptions) && options !== undefined)
        throw new TypeError("Too many arguments");
      const args = isArgumentList(argsOrOptions) ? argsOrOptions : [];
      const normalized = normalizeSpawn(
        file,
        args,
        isArgumentList(argsOrOptions) ? (options ?? {}) : (argsOrOptions ?? {}),
        defaults,
      );
      return start(normalized);
    }
    const shell = (command: string, options: NodeChildProcessOptions) =>
      start(normalizeShellCommand(command, options, defaults));
    const exec = createExecMethods(spawn, shell);
    const unsupportedSync = (): never =>
      unsupportedNodeOperation("child_process synchronous Computer exec");
    const ChildProcess = (..._args: unknown[]): never =>
      unsupportedNodeOperation("child_process.ChildProcess direct construction");
    Object.defineProperty(ChildProcess, Symbol.hasInstance, {
      value: (value: unknown) => value instanceof RemoteNodeChild,
    });
    return {
      spawn,
      ...exec,
      spawnSync: unsupportedSync,
      execSync: unsupportedSync,
      execFileSync: unsupportedSync,
      fork: unsupportedSync,
      ChildProcess,
    };
  };
}
