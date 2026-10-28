import { ABI_VERSION, type KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import { createChildBusyboxProgram } from "../ChildBusyboxProgram.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import type { ChildWorkerCode } from "../ChildWorkerProgram.ts";
import type { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import type { ChildProgramFactory } from "./ChildProgramFactory.ts";

interface ChildSedBindingsOptions {
  readonly registry: KernelProgramRegistry;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly lifetimes: ChildWorkerLifetimes;
  readonly child: ChildProgramFactory;
  readonly code: ChildWorkerCode;
}

export function createChildSedBindings(options: ChildSedBindingsOptions) {
  const bindings = new Map<string, KernelProgramBinding>();
  const dispatch = createWorkerLoaderDispatch<KernelBusyboxPort>(options.loader);
  const executable = "/bin/sed";
  const name = "@gnu/sed";
  const manifest = Object.freeze({
    name,
    version: KERNEL_GNU_SED_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint: `gnu-sed:${KERNEL_GNU_SED_ARTIFACT.sha256}`,
  });
  const result = options.registry.register(manifest);
  if (result.status !== "ok") {
    const detail = result.status === "error" ? result.error.message : "registration blocked";
    throw new Error(`Could not register ${name}: ${detail}`);
  }
  bindings.set(executable, {
    manifest,
    // GNU sed uses the same WASI and process metadata imports as BusyBox.
    implementation: options.child((admission) =>
      createChildBusyboxProgram({
        ...admission,
        executable,
        code: options.code,
        capacity: options.capacity,
        lifetimes: options.lifetimes,
        dispatch,
      }),
    ),
  });
  return bindings;
}
