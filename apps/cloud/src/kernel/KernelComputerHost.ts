import { KernelProgramRegistry } from "./KernelAbi.ts";
import {
  KernelProgramHost,
  type KernelProgramBinding,
  type KernelProgramHostOptions,
} from "./KernelProgramHost.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelProcessTable } from "./KernelProcessTable.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import type { KernelCommandForwarder } from "./KernelCommandForwarder.ts";
import { KernelCpuExecution } from "./KernelCpuExecution.ts";
import type { ComputerProgramOwnerPort } from "./KernelComputerAdmissionPort.ts";
import type { KernelExecutableNamespaceOwner } from "./KernelExecutableNamespace.ts";
import type { KernelProgramAdmissionRequest } from "./KernelProgramAdmission.ts";
import { createKernelComputerAdmission } from "./KernelComputerAdmission.ts";
import { createKernelCommandIngress } from "./KernelCommandIngress.ts";
import type { KernelCommandExecutorOptions } from "./KernelCommandExecutor.ts";

/** Registry entries are local syscall identities; Computer owns the executable bodies and grants. */
export async function createKernelComputerHost(options: {
  readonly owner: ComputerProgramOwnerPort;
  readonly filesystem: KernelFileSystem;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly machine: KernelCommandForwarder;
  readonly namespace: (request: KernelProgramAdmissionRequest) => KernelExecutableNamespaceOwner;
  readonly hostname: string;
  readonly cpuAccounting?: KernelProgramHostOptions["cpuAccounting"];
  readonly selectFileBytes?: KernelProgramHostOptions["selectFileBytes"];
  readonly parent?: KernelCommandExecutorOptions["parent"];
  readonly home?: string;
  readonly fileBytes?: KernelCommandExecutorOptions["fileBytes"];
}) {
  const registry = new KernelProgramRegistry();
  const bindings = new Map<string, KernelProgramBinding>();
  const registrations = await options.owner.registrations();
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const track = (lifetime: Promise<unknown>) => {
    pending.add(lifetime);
    void lifetime.then(
      () => pending.delete(lifetime),
      (error: unknown) => {
        pending.delete(lifetime);
        failures.push(error);
      },
    );
  };
  const admission = createKernelComputerAdmission({ ...options, track });
  for (const registration of registrations) {
    const result = registry.register(registration.manifest);
    if (result.status !== "ok") throw new Error(`Could not register ${registration.manifest.name}`);
    bindings.set(registration.executable, {
      manifest: registration.manifest,
      implementation: {
        kind: "async",
        ...(registration.sigpipe === undefined ? {} : { sigpipe: registration.sigpipe }),
        async run() {
          throw new Error("Computer grant is required for kernel program dispatch");
        },
      },
    });
  }
  const cpuExecution =
    options.cpuAccounting === undefined ? undefined : new KernelCpuExecution(options.cpuAccounting);
  const make = (localOnly: boolean) =>
    new KernelProgramHost({
      registry,
      programs: bindings,
      processes: options.processes,
      wakes: options.wakes,
      ...(cpuExecution === undefined ? {} : { cpuExecution }),
      ...(options.selectFileBytes === undefined
        ? {}
        : { selectFileBytes: options.selectFileBytes }),
      admit: (request) => admission(request, localOnly),
    });
  const host = make(false);
  const isolateHost = make(true);
  const common = {
    filesystem: options.filesystem,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.fileBytes === undefined ? {} : { fileBytes: options.fileBytes }),
  };
  const commands = createKernelCommandIngress({ ...common, host });
  const isolate = createKernelCommandIngress({ ...common, host: isolateHost });
  let closing: Promise<void> | undefined;
  const drain = async () => {
    while (pending.size > 0) await Promise.allSettled(pending);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Kernel dispatch cleanup failed");
  };
  return {
    ...commands,
    isolate,
    host,
    isolateHost,
    drain,
    close() {
      return (closing ??= (async () => {
        await options.owner.close();
        await drain();
      })());
    },
  };
}
