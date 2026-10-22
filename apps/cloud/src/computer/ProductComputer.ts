import { KernelProcessTable } from "../kernel/KernelProcessTable.ts";
import {
  systemIdentityForThread,
  type SystemIdentityConfig,
} from "@t3tools/contracts/systemIdentity";
import { createCommandGateway, type CommandGatewayOptions } from "./CommandGateway.ts";
import { CHILD_COREUTILS_COMMANDS } from "./ChildProgramSet.ts";
import {
  createCompiledChildWorkerLoader,
  type CompiledChildWorkerRegistry,
} from "./CompiledChildWorkerLoader.ts";
import type { ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import type { ChildWorkerLimits } from "./ChildWorkerLimits.ts";

export interface ProductComputerOptions extends Omit<
  CommandGatewayOptions,
  "processes" | "loader" | "systemIdentity" | "hostname"
> {
  readonly threadId: string;
  readonly systemIdentity?: SystemIdentityConfig;
  readonly signal: AbortSignal;
  readonly loader:
    | ChildWorkerLoaderPort
    | {
        readonly workerLoader: WorkerLoader;
        readonly compiledModules: CompiledChildWorkerRegistry;
        readonly limits?: ChildWorkerLimits;
      };
}

/** One thread owns the full command catalog and every admitted process, including machine work. */
export function createProductComputer(options: ProductComputerOptions) {
  const { programs } = options;
  const systemIdentity = systemIdentityForThread(options.threadId, options.systemIdentity);
  if (
    [
      programs.bash,
      programs.busyboxCat,
      programs.busyboxApplets,
      programs.ripgrep,
      programs.git,
    ].some((code) => code === undefined) ||
    CHILD_COREUTILS_COMMANDS.some((command) => programs.coreutils?.[command] === undefined)
  )
    throw new TypeError("Product Computer requires the full command catalog");
  const processes = new KernelProcessTable({ wakes: options.wakes });
  const loader =
    "run" in options.loader
      ? options.loader
      : createCompiledChildWorkerLoader(
          options.loader.workerLoader,
          options.loader.compiledModules,
          options.loader.limits,
        );
  const gateway = createCommandGateway({
    ...options,
    systemIdentity,
    hostname: systemIdentity.hostname,
    loader,
    processes,
  });
  const owner = new AbortController();
  const signal = AbortSignal.any([owner.signal, options.signal]);
  let closing: Promise<void> | undefined;
  return {
    ...gateway,
    systemIdentity,
    processes,
    exec: ((command, callerSignal, requester) =>
      gateway.exec(
        command,
        AbortSignal.any([signal, callerSignal]),
        requester,
      )) satisfies typeof gateway.exec,
    close() {
      closing ??= (async () => {
        owner.abort(new Error("Product Computer closed"));
        // Close admission before cancelling processes; drain acknowledges stopped child owners.
        const drained = gateway.close();
        void drained.catch(() => undefined);
        const disposed = await processes.dispose();
        const results = await Promise.allSettled([drained]);
        const failures: unknown[] = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (disposed.status !== "ok") failures.push(disposed);
        if (failures.length) throw new AggregateError(failures, "Product Computer cleanup failed");
      })();
      return closing;
    },
  };
}

export type ProductComputer = ReturnType<typeof createProductComputer>;
