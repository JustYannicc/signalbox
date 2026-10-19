import { RpcTarget, WorkerEntrypoint, exports as hostExports } from "cloudflare:workers";
import { createCompiledChildWorkerLoader } from "../../src/computer/CompiledChildWorkerLoader.ts";
import type { ChildWorkerInvocation } from "../../src/computer/ChildWorkerProgram.ts";
import {
  type ChildWorkerLimits,
  resolveChildWorkerLimits,
} from "../../src/computer/ChildWorkerLimits.ts";
import { CHILD_PROGRAM_WASM_REGISTRY } from "./programWasmRegistry.ts";

export type { ChildWorkerInvocation };

/** Proof facets receive this service instead of retaining a raw WorkerLoader binding. */
export class ChildWorkerDispatch extends WorkerEntrypoint<
  { LOADER: WorkerLoader },
  { limits?: ChildWorkerLimits }
> {
  async run(invocation: ChildWorkerInvocation, host: RpcTarget) {
    const limits = resolveChildWorkerLimits(this.ctx.props.limits);
    const dispatch = createCompiledChildWorkerLoader(
      this.env.LOADER,
      CHILD_PROGRAM_WASM_REGISTRY,
      limits,
    );
    // Preflight rejection calls stopped() to acknowledge that no child started. Computer
    // supplies it on its wrapped target; raw public callers must provide it themselves.
    return dispatch.run({ ...invocation, limits }, host);
  }
}

export function childWorkerDispatchBinding(limits?: ChildWorkerLimits) {
  const resolved = resolveChildWorkerLimits(limits);
  const entrypoints = hostExports as {
    ChildWorkerDispatch: LoopbackServiceStub<ChildWorkerDispatch>;
  };
  return entrypoints.ChildWorkerDispatch({ props: { limits: resolved } });
}
