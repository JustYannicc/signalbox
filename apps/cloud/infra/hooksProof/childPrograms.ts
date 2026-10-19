import { RpcTarget } from "cloudflare:workers";
import { ABI_VERSION, KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelOpenFlags, type KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../../src/kernel/KernelProgramHost.ts";
import type { KernelBashPort } from "../../src/kernel/KernelBashPort.ts";
import type {
  KernelBusyboxCall,
  KernelBusyboxCallResult,
  KernelBusyboxPort,
} from "../../src/kernel/KernelBusyboxPort.ts";
import type {
  KernelSyscallPort,
  KernelSyscallRequest,
} from "../../src/kernel/KernelSyscallPort.ts";
import { createChildWorkerProgram } from "../../src/computer/ChildWorkerProgram.ts";
import {
  createWorkerLoaderDispatch,
  type ChildWorkerLoaderPort,
} from "../../src/computer/WorkerLoaderDispatch.ts";
import { createWorkerBashHost } from "../../src/computer/WorkerBashHost.ts";
import { createChildBusyboxProgram } from "../../src/computer/ChildBusyboxProgram.ts";
import { createWorkerSyscalls } from "../../src/computer/WorkerSyscalls.ts";
import type { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import {
  KERNEL_BASH_ARTIFACT,
  type KernelBashCredentials,
} from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_BUSYBOX_VERSION } from "../../src/kernel/KernelBusyboxPrograms.ts";
import {
  KERNEL_RIPGREP_ARTIFACT,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
} from "../../src/kernel/KernelRipgrepProgram.ts";
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";
import type { HookChildProgramSources, HookChildWorkerCode } from "./preparePrograms.ts";

export interface CreateHookChildProgramBindingsOptions {
  readonly registry: KernelProgramRegistry;
  readonly filesystem: KernelFileSystem;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: ChildWorkerCapacity;
  readonly programs: HookChildProgramSources;
}

/** Registers child-only Bash, BusyBox cat and ripgrep bindings on the owning kernel. */
export function createHookChildPrograms(options: CreateHookChildProgramBindingsOptions) {
  const lifetimes = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const capacity = {
    run<T>(signal: AbortSignal, work: () => Promise<T>) {
      const lifetime = options.capacity.run(signal, work);
      lifetimes.add(lifetime);
      void lifetime.then(
        () => lifetimes.delete(lifetime),
        (error: unknown) => {
          failures.push(error);
          lifetimes.delete(lifetime);
        },
      );
      return lifetime;
    },
  };
  const credentials = bashCredentials(options.filesystem);
  const bashCode = attachProgramBytes(
    options.filesystem,
    "/bin/bash",
    options.programs.bash,
    KERNEL_BASH_ARTIFACT.bytes,
  );
  const busyboxCode = attachProgramBytes(
    options.filesystem,
    "/bin/cat",
    options.programs.busyboxCat,
    KERNEL_BUSYBOX_ARTIFACT.bytes,
  );
  const ripgrepCode = attachProgramBytes(
    options.filesystem,
    "/bin/rg",
    options.programs.ripgrep,
    KERNEL_RIPGREP_ARTIFACT.bytes,
  );
  const bashDispatch = createWorkerLoaderDispatch<KernelBashPort>(options.loader);
  const bash = createChildWorkerProgram({
    executable: "/bin/bash",
    code: bashCode,
    capacity,
    dispatch: bashDispatch,
    createHost: (context) => createWorkerBashHost({ context, credentials }),
  });

  const bashManifest = Object.freeze({
    name: "@nimbus/bash",
    version: KERNEL_BASH_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([
      "process.spawn" as const,
      "process.wait" as const,
      "process.signal" as const,
    ]),
    entrypoint: `nimbus-bash:${KERNEL_BASH_ARTIFACT.sha256}`,
  });
  const shManifest = Object.freeze({ ...bashManifest, name: "@nimbus/sh" });
  register(options.registry, bashManifest);
  register(options.registry, shManifest);

  const catManifest = Object.freeze({
    name: "@nimbus/busybox/cat",
    version: KERNEL_BUSYBOX_VERSION,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint: `busybox-${KERNEL_BUSYBOX_VERSION}:cat`,
  });
  register(options.registry, catManifest);
  const catDispatch = createWorkerLoaderDispatch<KernelBusyboxPort>(options.loader);
  const cat = createChildBusyboxProgram({
    executable: "/bin/cat",
    code: busyboxCode,
    capacity,
    dispatch: catDispatch,
    parentRpcTarget: (port) => new WorkerBusyboxPort(port),
  });

  register(options.registry, KERNEL_RIPGREP_PROGRAM_MANIFEST);
  const ripgrepDispatch = createWorkerLoaderDispatch<KernelSyscallPort>(options.loader);
  const ripgrep = createChildWorkerProgram({
    executable: "/bin/rg",
    code: ripgrepCode,
    capacity,
    dispatch: ripgrepDispatch,
    createHost(context) {
      return createWorkerSyscalls({
        filesystem: context.filesystem,
        args: context.args,
        env: { ...context.env, PWD: context.filesystem.cwd },
        signal: context.signal,
      });
    },
  });

  // Both shell paths use one immutable child program so the Bash bytes stay resident once.
  const bindings = new Map<string, KernelProgramBinding>([
    ["/bin/bash", { manifest: bashManifest, implementation: bash }],
    ["/bin/sh", { manifest: shManifest, implementation: bash }],
    ["/bin/cat", { manifest: catManifest, implementation: cat }],
    ["/bin/rg", { manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST, implementation: ripgrep }],
  ]);
  return {
    bindings,
    async drain() {
      // Logical root exit can precede the dispatch ACK and capability close.
      while (lifetimes.size > 0) await Promise.allSettled(lifetimes);
      if (failures.length > 0)
        throw new AggregateError(failures, "Hook child program cleanup failed");
    },
  };
}

function attachProgramBytes(
  filesystem: KernelFileSystem,
  path: "/bin/bash" | "/bin/cat" | "/bin/rg",
  code: HookChildWorkerCode,
  expectedBytes: number,
): ChildWorkerCode {
  if (Object.hasOwn(code.modules, "program.wasm")) {
    throw new Error(`Static child graph already contains program.wasm for ${path}`);
  }
  const wasm = readSeededExecutable(filesystem, path, expectedBytes);
  return Object.freeze({
    ...code,
    modules: Object.freeze({
      ...code.modules,
      "program.wasm": Object.freeze({ wasm }),
    }),
  });
}

function readSeededExecutable(
  filesystem: KernelFileSystem,
  path: "/bin/bash" | "/bin/cat" | "/bin/rg",
  expectedBytes: number,
): ArrayBuffer {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new RangeError(`Invalid expected executable size for ${path}`);
  }
  const descriptor = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const fileBytes = Number(filesystem.fstat(descriptor).size);
    if (fileBytes !== expectedBytes) {
      throw new Error(`Seeded executable size differs from the pinned ${path} artifact`);
    }
    const buffer = new ArrayBuffer(expectedBytes);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < expectedBytes) {
      const read = filesystem.read(descriptor, bytes.subarray(offset), null);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== expectedBytes) {
      throw new Error(`Seeded executable read was incomplete for ${path}`);
    }
    return buffer;
  } finally {
    filesystem.close(descriptor);
  }
}

class WorkerBusyboxPort extends RpcTarget implements KernelBusyboxPort {
  readonly #port: KernelBusyboxPort;

  constructor(port: KernelBusyboxPort) {
    super();
    this.#port = port;
  }

  call(request: KernelSyscallRequest) {
    return this.#port.call(request);
  }

  callBusybox(request: KernelBusyboxCall): Promise<KernelBusyboxCallResult> {
    return this.#port.callBusybox(request);
  }
}

function bashCredentials(filesystem: KernelFileSystem): KernelBashCredentials {
  const posix = filesystem.posixPolicy;
  if (posix === undefined) throw new Error("Child Bash requires the filesystem POSIX policy");
  return {
    uid: posix.credentials.uid,
    gid: posix.credentials.gid,
    euid: posix.credentials.euid,
    egid: posix.credentials.egid,
    umask: posix.umask,
    hostname: "signalbox-hooks-proof",
  };
}

function register(
  registry: KernelProgramRegistry,
  manifest: KernelProgramBinding["manifest"],
): void {
  const result = registry.register(manifest);
  if (result.status !== "ok") {
    const detail = result.status === "error" ? result.error.message : "registration blocked";
    throw new Error(`Could not register ${manifest.name}: ${detail}`);
  }
}
