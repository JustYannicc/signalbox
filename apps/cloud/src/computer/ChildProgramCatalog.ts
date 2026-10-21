import { ABI_VERSION, KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import type { KernelSyscallPort } from "../kernel/KernelSyscallPort.ts";
import { createChildWorkerProgram } from "./ChildWorkerProgram.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import { createWorkerBashHost } from "./WorkerBashHost.ts";
import { createChildBusyboxProgram } from "./ChildBusyboxProgram.ts";
import { createChildCoreutilsProgram } from "./ChildCoreutilsProgram.ts";
import { createWorkerSyscalls } from "./WorkerSyscalls.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import { KERNEL_BASH_ARTIFACT, type KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_VERSION } from "../kernel/KernelBusyboxPrograms.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST } from "../kernel/KernelRipgrepProgram.ts";
import type {
  ChildWorkerCode,
  ChildWorkerProgram,
  ChildWorkerProgramOptions,
} from "./ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
import type { ChildWorkerReservation } from "./ChildWorkerCapacity.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import {
  CHILD_BUSYBOX_APPLETS,
  CHILD_COREUTILS_COMMANDS,
  CHILD_PROGRAM_PATHS,
  type ChildCoreutilsCommand,
} from "./ChildProgramSet.ts";
import { KERNEL_COREUTILS_VERSION } from "../kernel/KernelCoreutilsPrograms.ts";
import { KERNEL_GIT_PROGRAM_MANIFEST } from "../kernel/KernelGitProgram.ts";
import { createWorkerGitHost } from "./WorkerGitHost.ts";
import type { KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import type { KernelGitPort } from "../kernel/KernelGitPort.ts";

export interface ChildProgramCodes {
  readonly bash: ChildWorkerCode;
  readonly busyboxCat: ChildWorkerCode;
  readonly busyboxApplets?: ChildWorkerCode;
  readonly ripgrep: ChildWorkerCode;
  readonly coreutils?: Partial<Readonly<Record<ChildCoreutilsCommand, ChildWorkerCode>>>;
  readonly git?: ChildWorkerCode;
}

export interface ChildProgramCatalogOptions {
  readonly registry: KernelProgramRegistry;
  readonly filesystem: KernelFileSystem;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly programs: ChildProgramCodes;
  readonly hostname: string;
  readonly lifetimes?: ChildWorkerLifetimes;
  readonly reservationFor?: (
    context: KernelAsyncProgramContext,
    implementation: ChildWorkerProgram,
  ) => ChildWorkerReservation;
}

export function createChildProgramCatalog(options: ChildProgramCatalogOptions) {
  const capacity = options.capacity;
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  const reserve = options.reservationFor;
  const child = (
    create: (
      admission: Pick<ChildWorkerProgramOptions<object>, "reservationFor">,
    ) => ChildWorkerProgram,
  ): ChildWorkerProgram => {
    let program: ChildWorkerProgram;
    program = create(
      reserve === undefined
        ? {}
        : {
            reservationFor: (context) => reserve(context, program),
          },
    );
    return program;
  };
  const credentials = bashCredentials(options.filesystem, options.hostname);
  const bashDispatch = createWorkerLoaderDispatch<KernelBashPort>(options.loader);
  const bash = child((admission) =>
    createChildWorkerProgram({
      ...admission,
      executable: "/bin/bash",
      code: options.programs.bash,
      capacity,
      lifetimes,
      dispatch: bashDispatch,
      createHost: (context, lease) => createWorkerBashHost({ context, credentials }, lease),
    }),
  );

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

  // Bash and sh share one immutable child program so the Bash bytes stay resident once.
  const bindings = new Map<string, KernelProgramBinding>([
    ["/bin/bash", { manifest: bashManifest, implementation: bash }],
    ["/bin/sh", { manifest: shManifest, implementation: bash }],
  ]);
  const catDispatch = createWorkerLoaderDispatch<KernelBusyboxPort>(options.loader);
  const applets = options.programs.busyboxApplets === undefined ? ["cat"] : CHILD_BUSYBOX_APPLETS;
  for (const applet of applets) {
    const manifest = Object.freeze({
      name: `@nimbus/busybox/${applet}`,
      version: KERNEL_BUSYBOX_VERSION,
      abiVersion: ABI_VERSION,
      requiredCapabilities: Object.freeze([]),
      entrypoint: `busybox-${KERNEL_BUSYBOX_VERSION}:${applet}`,
    });
    register(options.registry, manifest);
    bindings.set(`/bin/${applet}`, {
      manifest,
      implementation: child((admission) =>
        createChildBusyboxProgram({
          ...admission,
          executable: `/bin/${applet}`,
          code: options.programs.busyboxApplets ?? options.programs.busyboxCat,
          capacity,
          lifetimes,
          dispatch: catDispatch,
        }),
      ),
    });
  }

  register(options.registry, KERNEL_RIPGREP_PROGRAM_MANIFEST);
  const ripgrepDispatch = createWorkerLoaderDispatch<KernelSyscallPort>(options.loader);
  const ripgrep = child((admission) =>
    createChildWorkerProgram({
      ...admission,
      executable: "/bin/rg",
      code: options.programs.ripgrep,
      capacity,
      lifetimes,
      dispatch: ripgrepDispatch,
      childEnv: (context) => ({ ...context.env, PWD: context.filesystem.cwd }),
      createHost(context, lease) {
        return createWorkerSyscalls(
          {
            filesystem: context.filesystem,
            args: context.args,
            env: context.env,
            signal: context.signal,
          },
          lease,
        );
      },
    }),
  );

  bindings.set("/bin/rg", { manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST, implementation: ripgrep });

  const coreutilsDispatch = createWorkerLoaderDispatch<KernelCoreutilsPort>(options.loader);
  for (const command of CHILD_COREUTILS_COMMANDS) {
    const code = options.programs.coreutils?.[command];
    if (code === undefined) continue;
    const manifest = Object.freeze({
      name: `@agentos-software/coreutils/${command}`,
      version: KERNEL_COREUTILS_VERSION,
      abiVersion: ABI_VERSION,
      requiredCapabilities: Object.freeze([]),
      entrypoint: `coreutils-${KERNEL_COREUTILS_VERSION}:${command}`,
    });
    register(options.registry, manifest);
    bindings.set(`/bin/${command}`, {
      manifest,
      implementation: child((admission) =>
        createChildCoreutilsProgram({
          ...admission,
          executable: `/bin/${command}`,
          code,
          capacity,
          lifetimes,
          dispatch: coreutilsDispatch,
        }),
      ),
    });
  }

  const gitCode = options.programs.git;
  if (gitCode !== undefined) {
    register(options.registry, KERNEL_GIT_PROGRAM_MANIFEST);
    bindings.set("/usr/bin/git", {
      manifest: KERNEL_GIT_PROGRAM_MANIFEST,
      implementation: child((admission) =>
        createChildWorkerProgram({
          ...admission,
          executable: "/usr/bin/git",
          code: gitCode,
          capacity,
          lifetimes,
          dispatch: createWorkerLoaderDispatch<KernelGitPort>(options.loader),
          createHost: (context, lease) => createWorkerGitHost({ context }, lease),
        }),
      ),
    });
  }

  if (options.programs.busyboxApplets !== undefined) {
    for (const [command, path] of Object.entries(CHILD_PROGRAM_PATHS)) {
      const binding = bindings.get(path);
      if (binding === undefined) continue;
      // Logical executable spellings are explicit registrations, independent of PATH lookup.
      const manifest = Object.freeze({
        ...binding.manifest,
        name: `${binding.manifest.name}:command`,
      });
      register(options.registry, manifest);
      bindings.set(command, { manifest, implementation: binding.implementation });
    }
  }
  return {
    bindings,
    async drain() {
      try {
        await lifetimes.drain();
      } catch (error) {
        throw new AggregateError(
          error instanceof AggregateError ? error.errors : [error],
          "Child program cleanup failed",
          { cause: error },
        );
      }
    },
  };
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
