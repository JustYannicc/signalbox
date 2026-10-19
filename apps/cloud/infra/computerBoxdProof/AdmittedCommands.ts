import { KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type { KernelCommandForwarder } from "../../src/kernel/KernelCommandForwarder.ts";
import { KernelForwardingUnavailable } from "../../src/kernel/KernelCommandForwarder.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { ChildWorkerLifetimes } from "../../src/computer/ChildWorkerLifetimes.ts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { createComputerProgramAdmission } from "../../src/computer/ComputerProgramAdmission.ts";
import { COMPUTER_ISOLATE_POLICY } from "../../src/computer/EscalationPolicy.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { qualifyGnuCommand } from "../../src/computer/GnuCommandCompatibility.ts";
import {
  createSeededChildProgramCatalog,
  type SeededChildProgramCatalogOptions,
} from "../childPrograms/runtime.ts";
import type { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import type { KernelProcessTable } from "../../src/kernel/KernelProcessTable.ts";
import { nestedProofEscalation } from "./NestedCommand.ts";

/** Three genuine pinned programs, composed through the same public admission ports as the gateway. */
export function createProofAdmittedCommands(
  options: Pick<SeededChildProgramCatalogOptions, "filesystem" | "loader" | "programs"> & {
    readonly wakes: KernelWakeRegistry;
  },
) {
  const capacity = new ChildWorkerCapacity();
  const lifetimes = new ChildWorkerLifetimes();
  let fallbackRuns = 0;
  const observedCapacity = {
    tryReserve: (signal: AbortSignal) => capacity.tryReserve(signal),
    run: <T>(signal: AbortSignal, work: () => Promise<T>) => {
      fallbackRuns++;
      return capacity.run(signal, work);
    },
  };
  let machine: KernelCommandForwarder | undefined;
  const pair = (
    escalation: ComputerEscalationTable,
    forward: KernelCommandForwarder,
    processes?: KernelProcessTable,
  ) => {
    const counts = { rootRequests: 0, rootClaims: 0, descendantClaims: 0, forwards: 0 };
    const roots = new WeakSet<object>();
    const admission = createComputerProgramAdmission({
      escalation,
      capacity: observedCapacity,
      machine: {
        spawn: (command, signal) => {
          counts.forwards++;
          return forward.spawn(command, signal);
        },
      },
    });
    try {
      const registry = new KernelProgramRegistry();
      const catalog = createSeededChildProgramCatalog({
        ...options,
        registry,
        capacity: observedCapacity,
        hostname: "proof-host",
        lifetimes,
        reservationFor: (context, implementation) => {
          const reservation = admission.reservationFor(context, implementation);
          if (context.admission !== undefined && roots.has(context.admission)) counts.rootClaims++;
          else counts.descendantClaims++;
          return reservation;
        },
      });
      const host = new KernelProgramHost({
        registry,
        wakes: options.wakes,
        ...(processes === undefined ? {} : { processes }),
        programs: catalog.bindings,
        admit: async (request) => {
          if (request.kind === "command") counts.rootRequests++;
          const decision = await admission.admit(request);
          if (
            request.kind === "command" &&
            decision.kind === "local" &&
            decision.admission !== undefined
          )
            roots.add(decision.admission);
          return decision;
        },
      });
      return { host, admission, snapshot: () => ({ ...counts }) };
    } catch (error) {
      admission.close();
      throw error;
    }
  };
  const escalation = new ComputerEscalationTable(
    [...nestedProofEscalation().rules, { id: "proof-normal-cat", executable: "/bin/cat" }],
    COMPUTER_ISOLATE_POLICY,
    qualifyGnuCommand,
  );
  const normal = pair(escalation, {
    spawn: (command, signal) => {
      if (!machine) throw new Error("Nested proof machine is not bound");
      return machine.spawn(command, signal);
    },
  });
  let local: ReturnType<typeof pair>;
  try {
    local = pair(
      new ComputerEscalationTable(),
      {
        async spawn() {
          throw new KernelForwardingUnavailable("POLICY_NOT_READY", "Proof command is local-only");
        },
      },
      normal.host.processes,
    );
  } catch (error) {
    normal.admission.close();
    throw error;
  }
  const commands = createComputerCommands({
    mode: "admitted",
    kernel: { host: normal.host, filesystem: options.filesystem },
    isolateKernel: { host: local.host, filesystem: options.filesystem },
  });
  return {
    commands,
    host: normal.host,
    isolateHost: local.host,
    escalation,
    bindNestedMachine(forwarder: KernelCommandForwarder) {
      if (machine) throw new Error("Nested proof machine was already bound");
      machine = forwarder;
    },
    snapshot: () => ({
      normal: normal.snapshot(),
      local: local.snapshot(),
      fallbackRuns,
      active: capacity.active,
    }),
    admissionDiagnostics() {
      const counts = normal.snapshot();
      return {
        admittedRootGrantClaimedExactlyOnce: counts.rootRequests === 1 && counts.rootClaims === 1,
        admittedCatalogNoFallbackCapacityRun: fallbackRuns === 0,
        admittedNestedForwardExactlyOnce: counts.forwards === 1,
      };
    },
    async settledDiagnostics() {
      await lifetimes.drain();
      return { admittedPhysicalCapacityDrained: capacity.active === 0 };
    },
    drain: () => lifetimes.drain(),
    async close() {
      normal.admission.close();
      local.admission.close();
      await lifetimes.drain();
    },
  };
}
