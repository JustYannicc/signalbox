import type { KernelBashHostOptions } from "../kernel/KernelBashHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import {
  createChildWorkerRunner,
  type ChildWorkerCode,
  type ChildWorkerDispatch,
} from "./ChildWorkerProgram.ts";
import { createWorkerBashForkHost } from "./WorkerBashHost.ts";
import type { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

export function createChildBashForkDispatch(options: {
  readonly credentials: KernelBashHostOptions["credentials"];
  readonly code: ChildWorkerCode;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly dispatch: ChildWorkerDispatch<KernelBashPort>;
  readonly lifetimes: ChildWorkerLifetimes;
}): NonNullable<KernelBashHostOptions["runFork"]> {
  // Non-Bash children retain their slot while blocked. More leaf pipeline stages than the
  // caller's in-flight limit can still deadlock until #1388 can park those programs too.
  const runner = createChildWorkerRunner({ ...options, executable: "/bin/bash" });
  return async (context, owner, source) => {
    const state = await source.state();
    let memoryBytes: number;
    try {
      memoryBytes = state.memoryBytes;
    } finally {
      disposeKernelRpcReply(state);
    }
    return runner.run(
      context,
      (admitted, lease) =>
        createWorkerBashForkHost(
          { context: admitted, credentials: options.credentials },
          lease,
          owner,
          source,
        ),
      memoryBytes,
    );
  };
}
