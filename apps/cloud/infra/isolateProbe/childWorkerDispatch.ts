import { RpcTarget, WorkerEntrypoint, exports as hostExports } from "cloudflare:workers";
import type { KernelCommand, KernelCommandExit } from "../../src/kernel/KernelCommandForwarder.ts";

export interface ChildWorkerInvocation {
  readonly modules: Record<string, WorkerLoaderModule | string>;
  readonly mainModule: string;
  readonly entrypoint?: string;
  readonly command: KernelCommand;
}

interface ChildEntrypoint extends WorkerEntrypoint {
  run(command: KernelCommand, host: RpcTarget): Promise<KernelCommandExit>;
}

/** Proof facets receive this service instead of retaining a raw WorkerLoader binding. */
export class ChildWorkerDispatch extends WorkerEntrypoint<{ LOADER: WorkerLoader }> {
  async run(invocation: ChildWorkerInvocation, host: RpcTarget): Promise<KernelCommandExit> {
    const child = this.env.LOADER.get(null, () => ({
      compatibilityDate: "2026-10-18",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: invocation.mainModule,
      modules: invocation.modules,
      globalOutbound: null,
    }));
    return await child
      .getEntrypoint<ChildEntrypoint>(invocation.entrypoint)
      .run(invocation.command, host);
  }
}

export function childWorkerDispatchBinding() {
  const entrypoints = hostExports as {
    ChildWorkerDispatch: LoopbackServiceStub<ChildWorkerDispatch>;
  };
  return entrypoints.ChildWorkerDispatch({});
}
