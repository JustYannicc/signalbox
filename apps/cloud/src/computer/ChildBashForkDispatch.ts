import type { KernelBashHostOptions } from "../kernel/KernelBashHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
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
  // Bash waits and non-Bash pipe operations retain their physical slots until park is wired.
  // Work that needs more simultaneous workers than the caller's I/O limit can queue forever;
  // nested priority keeps descendants ahead of unrelated roots without exceeding that limit.
  const runner = createChildWorkerRunner({ ...options, executable: "/bin/bash" });
  return (context, owner, source) => {
    return runner.run(context, (admitted, lease) =>
      createWorkerBashForkHost(
        { context: admitted, credentials: options.credentials },
        lease,
        owner,
        source,
      ),
    );
  };
}
