import type { KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import { createChildWorkerProgram, type ChildWorkerProgramOptions } from "./ChildWorkerProgram.ts";
import { createWorkerCoreutilsHost } from "./WorkerCoreutilsHost.ts";

export type ChildCoreutilsProgramOptions = Omit<
  ChildWorkerProgramOptions<KernelCoreutilsPort>,
  "createHost" | "childEnv"
>;

/** Give the child planner and parent host the same admitted cwd environment. */
export function createChildCoreutilsProgram(options: ChildCoreutilsProgramOptions) {
  return createChildWorkerProgram({
    ...options,
    childEnv: (context) => ({ ...context.env, PWD: context.filesystem.cwd }),
    createHost: (context, lease) => createWorkerCoreutilsHost({ context }, lease),
  });
}
