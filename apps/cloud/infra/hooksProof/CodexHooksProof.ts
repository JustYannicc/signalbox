import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
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
  createHost: (wakes: KernelWakeRegistry) => KernelProgramHost,
  options: ProofFacetOptions,
) => ProofFacetClass;

/** Supplies a per-request hook runtime to the shared Codex app-server proof facet. */
export function createCodexHooksProofClass(
  engine: WebAssembly.Module,
  bash: WebAssembly.Module,
  createProofFacet: ProofFacetFactory,
): ProofFacetClass {
  const runtimes = new WeakMap<KernelProgramHost, ReturnType<typeof createCodexHookRuntime>>();
  return createProofFacet(
    engine,
    (wakes) => {
      const runtime = createCodexHookRuntime(bash, wakes);
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
