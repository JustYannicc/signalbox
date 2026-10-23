import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import { createKernelBashHost } from "../kernel/KernelBashHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import {
  createChildWorkerRunner,
  type ChildWorkerProgram,
  type ChildWorkerProgramOptions,
} from "./ChildWorkerProgram.ts";
import { ChildBashExecutionGroup } from "./ChildBashExecutionGroup.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

export function createChildBashProgram(
  options: Omit<ChildWorkerProgramOptions<KernelBashPort>, "createHost"> & {
    readonly credentials: KernelBashCredentials;
  },
): ChildWorkerProgram {
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  const { reservationFor: _reservationFor, ...unreserved } = options;
  const initial = createChildWorkerRunner({ ...options, lifetimes });
  const continued = createChildWorkerRunner({ ...unreserved, lifetimes });
  return Object.freeze({
    kind: "async" as const,
    prepare: initial.prepare,
    run(context: KernelAsyncProgramContext) {
      const group = new ChildBashExecutionGroup(initial, continued, options.credentials);
      const owner = createKernelBashHost({
        context,
        credentials: options.credentials,
        runFork: (forked, forkOwner, source) => group.run(forked, forkOwner, source),
      });
      group.run(context, owner, undefined, true);
      lifetimes.track(group.finish(owner.close));
      return owner.exited;
    },
    drain: () => lifetimes.drain(),
  });
}
