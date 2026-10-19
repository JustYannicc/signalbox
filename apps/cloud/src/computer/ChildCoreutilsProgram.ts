import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import { createChildWorkerProgram, type ChildWorkerProgramOptions } from "./ChildWorkerProgram.ts";
import { createWorkerCoreutilsHost } from "./WorkerCoreutilsHost.ts";

export type ChildCoreutilsProgramOptions = Omit<
  ChildWorkerProgramOptions<KernelCoreutilsPort>,
  "createHost"
>;

/** Give the child planner and parent host the same admitted cwd environment. */
export function createChildCoreutilsProgram(options: ChildCoreutilsProgramOptions) {
  const child = createChildWorkerProgram({
    ...options,
    createHost: (context) => createWorkerCoreutilsHost({ context }),
  });
  return Object.freeze({
    kind: "async" as const,
    run(context: KernelAsyncProgramContext) {
      return child.run({
        ...context,
        env: Object.freeze({ ...context.env, PWD: context.filesystem.cwd }),
      });
    },
  });
}
