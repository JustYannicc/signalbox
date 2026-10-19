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
    // Public probe callers supply their own RPC capability target. Computer's dispatch has
    // already wrapped that target with host()/stopped() before it reaches this loader.
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
