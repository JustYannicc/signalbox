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
  // With idle capacity and three initial Bash memories per isolate, N background two-stage pipelines need
  // at most N+2 fork workers, 2N exec workers and their root. Fifteen such jobs need <=48 of 64 permits;
  // an ordinary P-stage external pipeline needs <=max(1,P-1)+P, <=63 for P<=32.
  // Beyond that envelope, blocked pipe writers can fill the hard cap before their readers
  // are admitted. Queuing bounds admitted workers but cannot solve that existing deadlock;
  // it needs runnable-credit scheduling with parked continuations, not a larger fixed cap.
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
