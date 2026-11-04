import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashCredentials } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { ChildBashExecutionGroup } from "../ChildBashExecutionGroup.ts";
import { isStoppedWorkerLoaderQuotaFailure } from "../ChildWorkerDispatchError.ts";
import type { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import type { createChildWorkerRunner } from "../ChildWorkerProgram.ts";

type Runner = ReturnType<typeof createChildWorkerRunner<KernelBashPort>>;

export function startChildBash(
  context: KernelAsyncProgramContext,
  initial: Runner,
  continued: Runner,
  credentials: KernelBashCredentials,
  lifetimes: ChildWorkerLifetimes,
) {
  const group = new ChildBashExecutionGroup(initial, continued, credentials);
  const owner = createKernelBashHost({
    context,
    credentials,
    isStoppedQuotaFailure: isStoppedWorkerLoaderQuotaFailure,
    runFork: (forked, forkOwner, source) => group.run(forked, forkOwner, source),
  });
  group.run(context, owner, undefined, true);
  lifetimes.track(group.finish(owner.close));
  return owner;
}
