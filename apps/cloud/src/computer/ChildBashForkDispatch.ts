import type { KernelBashHostOptions } from "../kernel/KernelBashHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import { ChildHostLease } from "./ChildHostLease.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import type { ChildWorkerCode, ChildWorkerDispatch } from "./ChildWorkerProgram.ts";
import { createWorkerBashForkHost } from "./WorkerBashHost.ts";
import type { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

export function createChildBashForkDispatch(options: {
  readonly credentials: KernelBashHostOptions["credentials"];
  readonly code: ChildWorkerCode;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly dispatch: ChildWorkerDispatch<KernelBashPort>;
  readonly lifetimes: ChildWorkerLifetimes;
}): NonNullable<KernelBashHostOptions["runFork"]> {
  // With three Bash memories per isolate, N background two-stage pipelines need at most
  // N+2 fork workers, 2N exec workers and their root. R3's N=15 needs <=48 of 64 permits;
  // an ordinary P-stage external pipeline needs <=max(1,P-1)+P, <=63 for P<=32.
  // Beyond that envelope, blocked pipe writers can fill the hard cap before their readers
  // are admitted. Queuing preserves memory bounds but cannot solve that existing deadlock;
  // it needs runnable-credit scheduling with parked continuations, not a larger fixed cap.
  return (context, port, source) => {
    const result =
      Promise.withResolvers<Awaited<ReturnType<NonNullable<KernelBashPort["runFork"]>>>>();
    const lifetime = options.capacity.run(
      context.signal,
      async () => {
        context.signal.throwIfAborted();
        const lease = new ChildHostLease();
        const host = createWorkerBashForkHost(
          { context, credentials: options.credentials },
          lease,
          port,
          source,
        );
        try {
          const { modules, ...code } = options.code;
          return await options.dispatch.run(
            {
              ...code,
              modules: typeof modules === "function" ? await modules() : modules,
              command: {
                executable: "/bin/bash",
                argv: context.args,
                env: context.env,
                cwd: context.filesystem.cwd,
              },
            },
            host,
          );
        } catch (error) {
          result.reject(error);
          lease.release();
          // A lost transport cannot release physical capacity until the loader confirms termination.
          if (error instanceof ChildWorkerDispatchError && error.termination.kind === "unconfirmed")
            await error.termination.stopped;
          throw error;
        } finally {
          lease.release();
        }
      },
      { processes: context.processes, process: context.identity.handle },
    );
    options.lifetimes.track(lifetime.then(result.resolve, result.reject));
    return result.promise;
  };
}
