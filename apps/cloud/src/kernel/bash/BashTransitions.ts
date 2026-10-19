// Asyncify process transitions follow Nimbus e9f019ab4e40cb6037aff7e1a0eaf20842578ed3.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import type { BashProcess } from "./BashProcess.ts";
import { range, string, flatStrings, environment, errno } from "./BashMemory.ts";

export type BashContinuation = Pick<
  BashProcess,
  "exports" | "captures" | "stats" | "rewinding" | "resume" | "pending"
>;

export function rewindBash(process: BashContinuation, pointer = process.captures.top): void {
  process.rewinding = true;
  process.exports.asyncify_start_rewind(pointer);
}

export function bashTransitionImports(process: BashContinuation, pid: number) {
  const memory = () => process.exports.memory;
  const landing = (): boolean => {
    if (!process.rewinding) return false;
    process.exports.asyncify_stop_rewind();
    process.rewinding = false;
    return true;
  };
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
  const fork = () => (landing() ? process.resume : transition({ kind: "fork" }));
  return {
    setjmp: (env: number) => {
      if (landing()) return;
      range(memory(), env, 12);
      process.captures.setting(memory(), env);
      transition({ kind: "capture", env, stack: Number(process.exports.__stack_pointer.value) });
    },
    longjmp: (env: number, value: number) => {
      if (landing()) return;
      range(memory(), env, 12);
      transition({ kind: "longjmp", env, value: value || 1 });
    },
    fork,
    vfork: fork,
    execve: (path: number, argv: number, argvLength: number, env: number, envLength: number) => {
      if (landing()) return process.resume;
      try {
        return transition({
          kind: "exec",
          path: string(memory(), path),
          args: flatStrings(memory(), argv, argvLength),
          env: environment(flatStrings(memory(), env, envLength)),
        });
      } catch (error) {
        return -errno(error);
      }
    },
    waitpid: (pid: number, status: number, options: number) => {
      if (landing()) return process.resume;
      try {
        if (status !== 0) range(memory(), status, 4);
      } catch (error) {
        return -errno(error);
      }
      return transition({ kind: "wait", pid, status, options });
    },
  };
}
