import { KernelProcessTable } from "../kernel/KernelProcessTable.ts";
import {
  systemIdentityForThread,
  type SystemIdentity,
  type SystemIdentityConfig,
} from "@t3tools/contracts/systemIdentity";
import type { KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import { createCommandGateway, type CommandGatewayOptions } from "./CommandGateway.ts";
import { CHILD_COREUTILS_COMMANDS } from "./ChildProgramSet.ts";
import {
  createCompiledChildWorkerLoader,
  type CompiledChildWorkerRegistry,
} from "./CompiledChildWorkerLoader.ts";
import type { ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import type { ChildWorkerLimits } from "./ChildWorkerLimits.ts";
import { ComputerProgramResolver } from "./ComputerProgramResolver.ts";
import type { MachineProgramInventory } from "./MachineProgramInventory.ts";

export interface ProductComputerOptions extends Omit<
  CommandGatewayOptions,
  "processes" | "loader" | "systemIdentity" | "hostname" | "machine" | "resolver"
> {
  readonly threadId: string;
  readonly systemIdentity?: SystemIdentityConfig;
  /** Build the machine transport from the same resolved identity the isolate receives. */
  readonly machine: (systemIdentity: SystemIdentity) => KernelCommandForwarder & {
    readonly image: string;
    /** The inventory must describe the same immutable image this transport executes. */
    readonly inventory: MachineProgramInventory;
  };
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
      programs.sed,
    ].some((code) => code === undefined) ||
    CHILD_COREUTILS_COMMANDS.some((command) => programs.coreutils?.[command] === undefined)
  )
    throw new TypeError("Product Computer requires the full command catalog");
  const machine = options.machine(systemIdentity);
  if (!machine.inventory || machine.image !== machine.inventory.image)
    throw new TypeError("Machine executable inventory does not match the selected image");
  const resolver = new ComputerProgramResolver(options.filesystem, machine.inventory);
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
    machine,
    systemIdentity,
    hostname: systemIdentity.hostname,
    loader,
    processes,
    resolver,
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
