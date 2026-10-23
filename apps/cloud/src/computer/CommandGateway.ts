import { KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelProcessTable } from "../kernel/KernelProcessTable.ts";
import { KernelCpuExecution } from "../kernel/KernelCpuExecution.ts";
import { KernelProgramHost, type KernelProgramHostOptions } from "../kernel/KernelProgramHost.ts";
import type { KernelWakeRegistry } from "../kernel/KernelWakeRegistry.ts";
import type { KernelCommandExecutorOptions } from "../kernel/KernelCommandExecutor.ts";
import type { KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import { KernelForwardingUnavailable } from "../kernel/KernelCommandForwarder.ts";
import {
  createChildProgramCatalog,
  type ChildProgramCatalogOptions,
} from "./ChildProgramCatalog.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import type { ChildWorkerCode } from "./ChildWorkerProgram.ts";
import type { ChildCoreutilsCommand } from "./ChildProgramSet.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
import { createComputerCommands } from "./ComputerCommands.ts";
import {
  createComputerProgramAdmission,
  type ComputerProgramAdmissionOptions,
} from "./ComputerProgramAdmission.ts";
import { COMPUTER_ISOLATE_POLICY } from "./EscalationPolicy.ts";
import { ComputerEscalationTable } from "./EscalationTable.ts";
import { qualifyGnuCommand } from "./GnuCommandCompatibility.ts";

export type CommandProgramCodes = ChildProgramCatalogOptions["programs"] & {
  readonly busyboxApplets: ChildWorkerCode;
  readonly coreutils: Readonly<Record<ChildCoreutilsCommand, ChildWorkerCode>>;
  readonly git: ChildWorkerCode;
  readonly sed: ChildWorkerCode;
};

export interface CommandGatewayOptions {
  readonly filesystem: KernelFileSystem;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  /**
   * The context issuing the Dynamic Worker fetch owns its limit: ten for a DO, four for a Worker
   * request. The 2026-10-23 deployed probe confirmed hard rejection at 11/5 distinct live fetches
   * (see apps/cloud/src/computer/README.md).
   */
  readonly capacity: Pick<ChildWorkerCapacity, "enqueue" | "run" | "reserve">;
  readonly loader: ChildProgramCatalogOptions["loader"];
  readonly programs: CommandProgramCodes;
  readonly hostname: string;
  readonly systemIdentity?: SystemIdentity;
  readonly machine: KernelCommandForwarder;
  readonly evidence?: ComputerProgramAdmissionOptions["evidence"];
  readonly orderedMachineRules?: ConstructorParameters<typeof ComputerEscalationTable>[0];
  readonly parent?: KernelCommandExecutorOptions["parent"];
  readonly home?: string;
  readonly fileBytes?: KernelCommandExecutorOptions["fileBytes"];
  readonly cpuAccounting?: KernelProgramHostOptions["cpuAccounting"];
  readonly selectFileBytes?: KernelProgramHostOptions["selectFileBytes"];
}

/** Both ingress paths use admitted child bodies over one thread's resources. */
export function createCommandGateway(options: CommandGatewayOptions) {
  const lifetimes = new ChildWorkerLifetimes();
  // Both hosts run processes from one table, so they charge CPU through one execution meter.
  const cpuExecution =
    options.cpuAccounting === undefined ? undefined : new KernelCpuExecution(options.cpuAccounting);
  const localOnly: KernelCommandForwarder = {
    async spawn() {
      throw new KernelForwardingUnavailable(
        "POLICY_NOT_READY",
        "Local-only command is unavailable",
      );
    },
  };
  const pair = (
    escalation: ComputerEscalationTable,
    machine: KernelCommandForwarder,
    evidence?: ComputerProgramAdmissionOptions["evidence"],
  ) => {
    const admission = createComputerProgramAdmission({
      escalation,
      machine,
      capacity: options.capacity,
      ...(evidence === undefined ? {} : { evidence }),
    });
    try {
      const registry = new KernelProgramRegistry();
      const catalog = createChildProgramCatalog({
        registry,
        filesystem: options.filesystem,
        loader: options.loader,
        capacity: options.capacity,
        programs: options.programs,
        hostname: options.systemIdentity?.hostname ?? options.hostname,
        lifetimes,
        reservationFor: admission.reservationFor,
      });
      const host = new KernelProgramHost({
        registry,
        programs: catalog.bindings,
        wakes: options.wakes,
        processes: options.processes,
        admit: admission.admit,
        ...(cpuExecution === undefined ? {} : { cpuExecution }),
        ...(options.selectFileBytes === undefined
          ? {}
          : { selectFileBytes: options.selectFileBytes }),
      });
      return { host, admission };
    } catch (error) {
      admission.close();
      throw error;
    }
  };
  const normal = pair(
    new ComputerEscalationTable(options.orderedMachineRules, COMPUTER_ISOLATE_POLICY, (command) =>
      qualifyGnuCommand(command, options.filesystem),
    ),
    options.machine,
    options.evidence,
  );
  let local: ReturnType<typeof pair>;
  try {
    local = pair(new ComputerEscalationTable(), localOnly);
  } catch (error) {
    normal.admission.close();
    throw error;
  }
  const kernel = {
    filesystem: options.filesystem,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.fileBytes === undefined ? {} : { fileBytes: options.fileBytes }),
  };
  const commands = createComputerCommands({
    mode: "admitted",
    kernel: { ...kernel, host: normal.host },
    isolateKernel: { ...kernel, host: local.host },
  });
  return Object.freeze({
    ...commands,
    host: normal.host,
    isolateHost: local.host,
    drain: () => lifetimes.drain(),
    async close() {
      normal.admission.close();
      local.admission.close();
      await lifetimes.drain();
    },
  });
}
