import type { ChildWorkerDispatch, ChildWorkerInvocation } from "./ChildWorkerProgram.ts";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";

interface ChildEntrypoint<Host extends object> {
  run(command: KernelCommand, host: Host): Promise<KernelCommandExit>;
}

/** Code and syscalls are supplied by Computer; guest programs receive no outbound network binding. */
export function createWorkerLoaderDispatch<Host extends object>(
  loader: WorkerLoader,
): ChildWorkerDispatch<Host> {
  return {
    async run(input: ChildWorkerInvocation, host: Host) {
      const worker = loader.get(null, () => ({
        compatibilityDate: "2026-10-19",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: input.mainModule,
        modules: { ...input.modules },
        globalOutbound: null,
      }));
      const entrypoint = worker.getEntrypoint(input.entrypoint) as unknown as ChildEntrypoint<Host>;
      return await entrypoint.run(input.command, host);
    },
  };
}
