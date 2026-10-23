// Asyncify process transitions follow Nimbus e9f019ab4e40cb6037aff7e1a0eaf20842578ed3.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import type { BashProcess } from "./BashProcess.ts";
import { range, string, flatStrings, environment, errno } from "./BashMemory.ts";
import type { KernelBashImportCall, KernelBashOperation } from "../KernelBashCheckpoint.ts";

export type BashContinuation = Pick<
  BashProcess,
  "exports" | "captures" | "stats" | "rewinding" | "resume" | "pending" | "parked" | "checkpoint"
>;

export function rewindBash(process: BashContinuation, pointer = process.captures.top): void {
  process.rewinding = true;
  process.exports.asyncify_start_rewind(pointer);
}

export interface BashAsyncifyOperationHooks {
  /** Called by synchronous WASM imports; it records the call and starts Asyncify unwind. */
  readonly suspend: (operation: KernelBashOperation, call: KernelBashImportCall) => number;
  /** Stops a rewind when the saved import is reached and returns its prepared result. */
  readonly landing: () => number | undefined;
}

export function createBashAsyncifyOperationHooks(
  process: BashContinuation,
  pid: number,
): BashAsyncifyOperationHooks {
  const memory = () => process.exports.memory;
  return {
    suspend(operation, call) {
      process.pending = { kind: "operation", operation, call };
      const at = process.captures.unwindAt(
        memory(),
        Number(process.exports.__stack_pointer.value),
        process.stats,
        pid,
      );
      process.exports.asyncify_start_unwind(at);
      return 0;
    },
    landing() {
      if (!process.rewinding) return undefined;
      process.exports.asyncify_stop_rewind();
      process.rewinding = false;
      return process.resume;
    },
  };
}

export function bashTransitionImports(
  process: BashContinuation,
  pid: number,
  hooks = createBashAsyncifyOperationHooks(process, pid),
) {
  const memory = () => process.exports.memory;
  const transition = (reason: NonNullable<BashProcess["pending"]>): number => {
    process.pending = reason;
    const at = process.captures.unwindAt(
      memory(),
      Number(process.exports.__stack_pointer.value),
      process.stats,
      pid,
    );
    process.exports.asyncify_start_unwind(at);
    return 0;
  };
  const landed = () => hooks.landing() !== undefined;
  const fork = () => (landed() ? process.resume : transition({ kind: "fork" }));
  return {
    setpgid: (_pid: number, _group: number) => -58,
    tcgetpgrp: (_fd: number) => -59,
    tcsetpgrp: (_fd: number, _group: number) => -59,
    tcgetattr: (_fd: number, _termios: number) => -59,
    tcsetattr: (_fd: number, _action: number, _termios: number) => -59,
    setjmp: (env: number) => {
      if (landed()) return;
      range(memory(), env, 12);
      process.captures.setting(memory(), env);
      transition({ kind: "capture", env, stack: Number(process.exports.__stack_pointer.value) });
    },
    longjmp: (env: number, value: number) => {
      if (landed()) return;
      range(memory(), env, 12);
      transition({ kind: "longjmp", env, value: value || 1 });
    },
    fork,
    vfork: fork,
    execve: (path: number, argv: number, argvLength: number, env: number, envLength: number) => {
      if (landed()) return process.resume;
      try {
        const request = {
          path: string(memory(), path),
          args: flatStrings(memory(), argv, argvLength),
          env: environment(flatStrings(memory(), env, envLength)),
        };
        return hooks.suspend(
          { kind: "exec", request },
          {
            namespace: "nimbus_proc",
            name: "execve",
            args: [path, argv, argvLength, env, envLength],
          },
        );
      } catch (error) {
        return -errno(error);
      }
    },
    waitpid: (pid: number, status: number, options: number) => {
      if (landed()) return process.resume;
      try {
        if (status !== 0) range(memory(), status, 4);
      } catch (error) {
        return -errno(error);
      }
      return hooks.suspend(
        { kind: "wait", pid, options },
        { namespace: "nimbus_proc", name: "waitpid", args: [pid, status, options] },
      );
    },
  };
}
