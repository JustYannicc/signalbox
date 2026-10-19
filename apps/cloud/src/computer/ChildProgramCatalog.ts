import { RpcTarget } from "cloudflare:workers";
import { ABI_VERSION, KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type {
  KernelBusyboxCall,
  KernelBusyboxCallResult,
  KernelBusyboxPort,
} from "../kernel/KernelBusyboxPort.ts";
import type { KernelSyscallPort, KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import { createChildWorkerProgram } from "./ChildWorkerProgram.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import { createWorkerBashHost } from "./WorkerBashHost.ts";
import { createChildBusyboxProgram } from "./ChildBusyboxProgram.ts";
import { createWorkerSyscalls } from "./WorkerSyscalls.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import { KERNEL_BASH_ARTIFACT, type KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_VERSION } from "../kernel/KernelBusyboxPrograms.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST } from "../kernel/KernelRipgrepProgram.ts";
import type { ChildWorkerCode } from "./ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
export interface ChildProgramCodes {
  readonly bash: ChildWorkerCode;
  readonly busyboxCat: ChildWorkerCode;
  readonly ripgrep: ChildWorkerCode;
}

export interface ChildProgramCatalogOptions {
  readonly registry: KernelProgramRegistry;
  readonly filesystem: KernelFileSystem;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly programs: ChildProgramCodes;
  readonly hostname: string;
}

export function createChildProgramCatalog(options: ChildProgramCatalogOptions) {
  const capacity = options.capacity;
  const lifetimes = new ChildWorkerLifetimes();
  const credentials = bashCredentials(options.filesystem, options.hostname);
  const bashDispatch = createWorkerLoaderDispatch<KernelBashPort>(options.loader);
  const bash = createChildWorkerProgram({
    executable: "/bin/bash",
    code: options.programs.bash,
    capacity,
    lifetimes,
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
    code: options.programs.busyboxCat,
    capacity,
    lifetimes,
    dispatch: catDispatch,
    parentRpcTarget: (port) => new WorkerBusyboxPort(port),
  });

  register(options.registry, KERNEL_RIPGREP_PROGRAM_MANIFEST);
  const ripgrepDispatch = createWorkerLoaderDispatch<KernelSyscallPort>(options.loader);
  const ripgrep = createChildWorkerProgram({
    executable: "/bin/rg",
    code: options.programs.ripgrep,
    capacity,
    lifetimes,
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
      try {
        await lifetimes.drain();
      } catch (error) {
        throw new AggregateError(
          error instanceof AggregateError ? error.errors : [error],
          "Child program cleanup failed",
        );
      }
    },
  };
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

function bashCredentials(filesystem: KernelFileSystem, hostname: string): KernelBashCredentials {
  const posix = filesystem.posixPolicy;
  if (posix === undefined) throw new Error("Child Bash requires the filesystem POSIX policy");
  return {
    uid: posix.credentials.uid,
    gid: posix.credentials.gid,
    euid: posix.credentials.euid,
    egid: posix.credentials.egid,
    umask: posix.umask,
    hostname,
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
