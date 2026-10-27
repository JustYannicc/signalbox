import { ABI_VERSION, type KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import { createChildBusyboxProgram } from "../ChildBusyboxProgram.ts";
import { CHILD_UGREP_EXECUTABLES } from "../ChildProgramSet.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import type { ChildWorkerCode } from "../ChildWorkerProgram.ts";
import type { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import type { ChildProgramFactory } from "./ChildProgramFactory.ts";

export function createChildUgrepBindings(options: {
  readonly registry: KernelProgramRegistry;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly lifetimes: ChildWorkerLifetimes;
  readonly child: ChildProgramFactory;
  readonly code: ChildWorkerCode;
}) {
  const bindings = new Map<string, KernelProgramBinding>();
  const dispatch = createWorkerLoaderDispatch<KernelBusyboxPort>(options.loader);
  for (const executable of CHILD_UGREP_EXECUTABLES) {
    const manifest = Object.freeze({
      name: executable === "/bin/ugrep" ? "@ugrep/ugrep" : "@ugrep/ugrep:claude-multicall",
      version: KERNEL_UGREP_ARTIFACT.version,
      abiVersion: ABI_VERSION,
      requiredCapabilities: Object.freeze([]),
      entrypoint: `ugrep:${KERNEL_UGREP_ARTIFACT.sha256}`,
    });
    const registered = options.registry.register(manifest);
    if (registered.status !== "ok") throw new Error(`Could not register ${manifest.name}`);
    bindings.set(executable, {
      manifest,
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
  }
  return bindings;
}
