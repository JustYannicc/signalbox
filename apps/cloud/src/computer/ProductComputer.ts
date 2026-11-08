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
import type { MachineFilesPort } from "./MachineFilesPort.ts";
import { createComputerMachineProfile } from "./ComputerMachineProfile.ts";
import { createKernelExecutableNamespace } from "../kernel/KernelExecutableNamespace.ts";
import { createCodeModeHostProgram } from "./CodeModeHost.ts";
import { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import type { CodeModeLifecycleObserver } from "../codeMode/Lifecycle.ts";

export interface ProductComputerOptions extends Omit<
  CommandGatewayOptions,
  | "processes"
  | "loader"
  | "systemIdentity"
  | "hostname"
  | "machine"
  | "resolver"
  | "namespace"
  | "physicalCapacity"
> {
  readonly threadId: string;
  readonly capacity: CommandGatewayOptions["capacity"] &
    Pick<ChildWorkerCapacity, "limit" | "owner" | "residentByteLimit">;
  readonly systemIdentity?: SystemIdentityConfig;
  readonly machineInventory: MachineProgramInventory;
  /** Build the machine transport from the same resolved identity the isolate receives. */
  readonly machine: (systemIdentity: SystemIdentity) => KernelCommandForwarder & {
    readonly files: MachineFilesPort;
  };
  readonly signal: AbortSignal;
  readonly onCodeModeLifecycle?: CodeModeLifecycleObserver | undefined;
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
      programs.productBusyboxApplets,
      programs.ripgrep,
      programs.git,
      programs.sed,
      programs.jq,
      programs.ugrep,
    ].some((code) => code === undefined) ||
    CHILD_COREUTILS_COMMANDS.some((command) => programs.coreutils?.[command] === undefined)
  )
    throw new TypeError("Product Computer requires the full command catalog");
  const owner = new AbortController();
  const signal = AbortSignal.any([owner.signal, options.signal]);
  const { overlay, machine } = createComputerMachineProfile({
    ...options,
    transport: options.machine(systemIdentity),
    signal,
  });
  const resolver = new ComputerProgramResolver({ path: options.machineInventory.path });
  const processes = new KernelProcessTable({ wakes: options.wakes });
  const loader =
    "run" in options.loader
      ? options.loader
      : createCompiledChildWorkerLoader(
          options.loader.workerLoader,
          options.loader.compiledModules,
          options.loader.limits,
        );
  // Both pools issue dynamic calls from this DO context, whose physical limit is ten.
  const physicalCapacity = new ChildWorkerCapacity(10, {
    owner: `${options.capacity.owner}/worker-context`,
    RESIDENT_BYTE_LIMIT: String(options.capacity.residentByteLimit),
  });
  let gateway: ReturnType<typeof createCommandGateway>;
  try {
    const codeModeHost =
      programs.codeMode === undefined
        ? undefined
        : (() => {
            if (loader.cells === undefined)
              throw new TypeError("Product Computer requires a CodeMode cell loader");
            // Cells may await commands, so they must never consume the final command permit.
            const cells = new ChildWorkerCapacity(
              Math.min(options.capacity.limit, physicalCapacity.limit - 1),
              {
                owner: `${options.capacity.owner}/code-mode`,
                RESIDENT_BYTE_LIMIT: String(options.capacity.residentByteLimit),
              },
            );
            return createCodeModeHostProgram({
              loader: loader.cells,
              capacity: {
                async acquire(signal) {
                  const logical = await cells.acquire(signal, undefined);
                  try {
                    const physical = await physicalCapacity.acquire(signal, undefined);
                    return {
                      async release() {
                        try {
                          await physical.release();
                        } finally {
                          await logical.release();
                        }
                      },
                    };
                  } catch (error) {
                    await logical.release();
                    throw error;
                  }
                },
              },
              code: programs.codeMode,
              onLifecycle: options.onCodeModeLifecycle,
            });
          })();
    gateway = createCommandGateway({
      ...options,
      machine,
      systemIdentity,
      hostname: systemIdentity.hostname,
      loader,
      physicalCapacity,
      processes,
      ...(codeModeHost === undefined ? {} : { codeModeHost }),
      resolver,
      namespace: (request) =>
        createKernelExecutableNamespace({
          filesystem: request.filesystem,
          signal: request.signal,
          overlay,
        }),
    });
  } catch (error) {
    overlay.dispose();
    throw error;
  }
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
        const results = await Promise.allSettled([drained, processes.dispose()]);
        const failures: unknown[] = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        const disposed = results[1];
        if (disposed?.status === "fulfilled" && disposed.value.status !== "ok")
          failures.push(disposed.value);
        try {
          overlay.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, "Product Computer cleanup failed");
      })();
      return closing;
    },
  };
}

export type ProductComputer = ReturnType<typeof createProductComputer>;
