import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import type { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import {
  createCodexHookRuntime,
  type CodexHookRuntimeComposition,
  type CodexHookRuntimeConfiguration,
} from "./codexRuntime.ts";

interface ProofFacetConfiguration extends CodexHookRuntimeConfiguration {
  readonly filesystem: KernelFileSystem;
  readonly host: KernelProgramHost;
  readonly wakes: KernelWakeRegistry;
}

interface ProofFacetOptions {
  configure(input: ProofFacetConfiguration): CodexHookRuntimeComposition;
}

type ProofFacetClass = new (...args: never[]) => object;

type ProofFacetFactory = (
  engine: WebAssembly.Module,
  createHost: (
    wakes: KernelWakeRegistry,
    owner: { readonly context: DurableObjectState },
  ) => KernelProgramHost,
  options: ProofFacetOptions,
) => ProofFacetClass;

/** Supplies a per-request hook runtime to the shared Codex app-server proof facet. */
export function createCodexHooksProofClass(
  engine: WebAssembly.Module,
  bash: WebAssembly.Module,
  createProofFacet: ProofFacetFactory,
): ProofFacetClass {
  const runtimes = new WeakMap<KernelProgramHost, ReturnType<typeof createCodexHookRuntime>>();
  const capacities = new WeakMap<DurableObjectState, ChildWorkerCapacity>();
  return createProofFacet(
    engine,
    (wakes, owner) => {
      let capacity = capacities.get(owner.context);
      if (!capacity) {
        capacity = new ChildWorkerCapacity();
        capacities.set(owner.context, capacity);
      }
      const runtime = createCodexHookRuntime(bash, wakes, capacity);
      runtimes.set(runtime.host, runtime);
      return runtime.host;
    },
    {
      configure(input) {
        const runtime = runtimes.get(input.host);
        if (!runtime) throw new Error("Codex proof runtime was not created for this request");
        return runtime.configure(input);
      },
    },
  );
}
