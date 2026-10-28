import { ABI_VERSION, KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelSyscallPort } from "../kernel/KernelSyscallPort.ts";
import { createChildWorkerProgram } from "./ChildWorkerProgram.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import { createChildBashProgram } from "./ChildBashProgram.ts";
import { createChildCoreutilsProgram } from "./ChildCoreutilsProgram.ts";
import { createWorkerSyscalls } from "./WorkerSyscalls.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import { KERNEL_BASH_ARTIFACT, type KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST } from "../kernel/KernelRipgrepProgram.ts";
import type { ChildWorkerCode, ChildWorkerProgram } from "./ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
import type { ChildWorkerReservation } from "./ChildWorkerCapacity.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import { CHILD_COREUTILS_COMMANDS, type ChildCoreutilsCommand } from "./ChildProgramSet.ts";
import { KERNEL_COREUTILS_VERSION } from "../kernel/KernelCoreutilsPrograms.ts";
import { KERNEL_GIT_PROGRAM_MANIFEST } from "../kernel/KernelGitProgram.ts";
import { createWorkerGitHost } from "./WorkerGitHost.ts";
import type { KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import type { KernelGitPort } from "../kernel/KernelGitPort.ts";
import { createChildBusyboxBindings } from "./catalog/BusyboxPrograms.ts";
import type { ChildProgramFactory } from "./catalog/ChildProgramFactory.ts";
import { createChildJqBinding } from "./catalog/JqProgram.ts";
import { createChildSedBindings } from "./catalog/SedPrograms.ts";
import { createChildUgrepBindings } from "./catalog/UgrepPrograms.ts";
import { registerProgramAliases } from "./catalog/ProgramAliases.ts";

export interface ChildProgramCodes {
  readonly bash: ChildWorkerCode;
  readonly busyboxCat: ChildWorkerCode;
  readonly busyboxApplets?: ChildWorkerCode;
  readonly productBusyboxApplets?: ChildWorkerCode;
  readonly ripgrep: ChildWorkerCode;
  readonly coreutils?: Partial<Readonly<Record<ChildCoreutilsCommand, ChildWorkerCode>>>;
  readonly git?: ChildWorkerCode;
  readonly sed?: ChildWorkerCode;
  readonly jq?: ChildWorkerCode;
  readonly ugrep?: ChildWorkerCode;
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
  const child: ChildProgramFactory = (create) => {
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
  const bashCode = options.programs.bash;
  const bashDispatch = createWorkerLoaderDispatch<KernelBashPort>(options.loader);
  const bash = child((admission) =>
    createChildBashProgram({
      ...admission,
      executable: "/bin/bash",
      code: bashCode,
      capacity,
      lifetimes,
      dispatch: bashDispatch,
      credentials,
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
  for (const [path, binding] of createChildBusyboxBindings({
    registry: options.registry,
    loader: options.loader,
    capacity,
    lifetimes,
    child,
    programs: options.programs,
  })) {
    bindings.set(path, binding);
  }
  if (options.programs.sed !== undefined) {
    for (const [path, binding] of createChildSedBindings({
      registry: options.registry,
      loader: options.loader,
      capacity,
      lifetimes,
      child,
      code: options.programs.sed,
    })) {
      bindings.set(path, binding);
    }
  }

  if (options.programs.ugrep !== undefined) {
    for (const [path, binding] of createChildUgrepBindings({
      registry: options.registry,
      loader: options.loader,
      capacity,
      lifetimes,
      child,
      code: options.programs.ugrep,
    }))
      bindings.set(path, binding);
  }

  register(options.registry, KERNEL_RIPGREP_PROGRAM_MANIFEST);
  const ripgrepDispatch = createWorkerLoaderDispatch<KernelSyscallPort>(options.loader);
  const ripgrep = child((admission) =>
    createChildWorkerProgram({
      ...admission,
      executable: "/bin/rg",
      sigpipe: "epipe",
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
            process: context,
            sigpipe: "epipe",
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

  const jqCode = options.programs.jq;
  if (jqCode !== undefined) {
    bindings.set(
      "/usr/bin/jq",
      createChildJqBinding({
        registry: options.registry,
        loader: options.loader,
        capacity,
        lifetimes,
        child,
        code: jqCode,
      }),
    );
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

  const aliases = registerProgramAliases(options.registry, bindings);
  return {
    bindings,
    aliases,
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
