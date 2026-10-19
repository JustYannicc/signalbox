import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import type { ChildWorkerLoaderPort } from "../../src/computer/WorkerLoaderDispatch.ts";
import type { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { decodeVerifiedAssetBundle } from "../claudeTurnProof/assetBundle.ts";
import { readAssetBody } from "../claudeTurnProof/proofObservation.ts";
import { createSeededChildProgramCatalog } from "../childPrograms/runtime.ts";
import type {
  ChildProgramExecutableCatalog,
  ChildProgramSources,
} from "../childPrograms/prepare.ts";
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

interface ProofHostOwner {
  readonly context: DurableObjectState;
  readonly filesystem: KernelFileSystem;
  readonly env: { readonly CHILD_WORKERS: ChildWorkerLoaderPort };
  readonly request: Request;
}

type ProofFacetClass = new (...args: never[]) => object;

type ProofFacetFactory = (
  engine: WebAssembly.Module,
  createHost: (wakes: KernelWakeRegistry, owner: ProofHostOwner) => Promise<KernelProgramHost>,
  options: ProofFacetOptions,
) => ProofFacetClass;

/** Supplies a per-request hook runtime to the shared Codex app-server proof facet. */
export function createCodexHooksProofClass(
  engine: WebAssembly.Module,
  programs: ChildProgramSources,
  catalog: ChildProgramExecutableCatalog,
  createProofFacet: ProofFacetFactory,
): ProofFacetClass {
  const runtimes = new WeakMap<KernelProgramHost, ReturnType<typeof createCodexHookRuntime>>();
  const capacities = new WeakMap<DurableObjectState, ChildWorkerCapacity>();
  return createProofFacet(
    engine,
    async (wakes, owner) => {
      let capacity = capacities.get(owner.context);
      if (!capacity) {
        capacity = new ChildWorkerCapacity();
        capacities.set(owner.context, capacity);
      }
      await seedPrograms(owner.filesystem, owner.request, catalog, owner.context.storage);
      const sharedCapacity = capacity;
      const loader: ChildWorkerLoaderPort = {
        run: (invocation, capability) => owner.env.CHILD_WORKERS.run(invocation, capability),
      };
      const runtime = createCodexHookRuntime(
        (registry) =>
          createSeededChildProgramCatalog({
            hostname: "signalbox-hooks-proof",
            registry,
            filesystem: owner.filesystem,
            programs,
            capacity: sharedCapacity,
            loader,
          }),
        wakes,
        sharedCapacity,
      );
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

async function seedPrograms(
  filesystem: KernelFileSystem,
  request: Request,
  catalog: ChildProgramExecutableCatalog,
  storage: DurableObjectStorage,
) {
  const entries = await decodeVerifiedAssetBundle(await readAssetBody(request), catalog);
  storage.transactionSync(() => {
    for (const entry of entries) {
      const fd = filesystem.open(
        entry.path,
        KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC,
        0o755,
      );
      try {
        let offset = 0;
        while (offset < entry.bytes.byteLength) {
          const written = filesystem.write(fd, entry.bytes.subarray(offset), null);
          if (written <= 0) throw new Error(`Executable seed made no progress for ${entry.path}`);
          offset += written;
        }
      } finally {
        filesystem.close(fd);
      }
      filesystem.chmod(entry.path, 0o755);
    }
  });
}
