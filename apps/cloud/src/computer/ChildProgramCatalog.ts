import type { KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { ChildWorkerProgram } from "./ChildWorkerProgram.ts";
import type { ChildProgramCodes } from "./ChildProgramCodes.ts";
export type { ChildProgramCodes } from "./ChildProgramCodes.ts";
import { createChildBashProgram } from "./ChildBashProgram.ts";
import { createChildCoreutilsProgram } from "./ChildCoreutilsProgram.ts";
import { createChildBusyboxProgram } from "./ChildBusyboxProgram.ts";
import { createChildWorkerProgram } from "./ChildWorkerProgram.ts";
import { createWorkerSyscalls } from "./WorkerSyscalls.ts";
import { createWorkerGitHost } from "./WorkerGitHost.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import type { ChildWorkerCapacity, ChildWorkerReservation } from "./ChildWorkerCapacity.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
import {
  createComputerProgramCatalog,
  type ComputerCatalogProgram,
  type ComputerCodeModeHost,
} from "./ComputerProgramCatalog.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import type { KernelGitPort } from "../kernel/KernelGitPort.ts";
import type { KernelSyscallPort } from "../kernel/KernelSyscallPort.ts";

export interface ChildProgramCatalogOptions {
  readonly registry: KernelProgramRegistry;
  readonly filesystem: KernelFileSystem;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly physicalCapacity?: Pick<ChildWorkerCapacity, "acquire"> | undefined;
  readonly programs: ChildProgramCodes;
  readonly codeModeHost?: ComputerCodeModeHost;
  readonly hostname: string;
  readonly lifetimes?: ChildWorkerLifetimes;
  readonly reservationFor?: (
    context: KernelAsyncProgramContext,
    implementation: ChildWorkerProgram,
  ) => ChildWorkerReservation;
}

export function createChildProgramCatalog(options: ChildProgramCatalogOptions) {
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  const catalog = createComputerProgramCatalog(options.programs, options.codeModeHost);
  const implementations = new Map<string, ChildWorkerProgram>();
  const bindings = new Map<string, KernelProgramBinding>();
  const credentials = bashCredentials(options.filesystem, options.hostname);
  const create = (entry: ComputerCatalogProgram) => {
    let program: ChildWorkerProgram;
    const common = {
      executable: entry.implementation,
      code: entry.code,
      capacity: options.capacity,
      physicalCapacity: options.physicalCapacity,
      lifetimes,
      ...(options.reservationFor === undefined
        ? {}
        : {
            reservationFor: (context: KernelAsyncProgramContext) =>
              options.reservationFor!(context, program),
          }),
    };
    switch (entry.hostKind) {
      case "bash":
        program = createChildBashProgram({
          ...common,
          credentials,
          dispatch: createWorkerLoaderDispatch<KernelBashPort>(options.loader),
        });
        break;
      case "busybox":
        program = createChildBusyboxProgram({
          ...common,
          dispatch: createWorkerLoaderDispatch<KernelBusyboxPort>(options.loader),
        });
        break;
      case "coreutils":
        program = createChildCoreutilsProgram({
          ...common,
          dispatch: createWorkerLoaderDispatch<KernelCoreutilsPort>(options.loader),
        });
        break;
      case "git":
        program = createChildWorkerProgram({
          ...common,
          dispatch: createWorkerLoaderDispatch<KernelGitPort>(options.loader),
          createHost: (context, lease) => createWorkerGitHost({ context }, lease),
        });
        break;
      case "syscall":
        program = createChildWorkerProgram({
          ...common,
          ...(entry.sigpipe === undefined ? {} : { sigpipe: entry.sigpipe }),
          dispatch: createWorkerLoaderDispatch<KernelSyscallPort>(options.loader),
          childEnv: (context) => ({ ...context.env, PWD: context.filesystem.cwd }),
          createHost: (context, lease) =>
            createWorkerSyscalls(
              {
                filesystem: context.filesystem,
                args: context.args,
                env: context.env,
                signal: context.signal,
                process: context,
                sigpipe: "epipe",
              },
              lease,
            ),
        });
    }
    return program;
  };
  for (const [path, entry] of catalog.programs) {
    const registered = options.registry.register(entry.manifest);
    if (registered.status !== "ok") throw new Error(`Could not register ${entry.manifest.name}`);
    let implementation = implementations.get(entry.implementation);
    if (implementation === undefined) {
      implementation = create(entry);
      implementations.set(entry.implementation, implementation);
    }
    bindings.set(path, { manifest: entry.manifest, implementation });
  }
  for (const [path, binding] of catalog.asyncPrograms) {
    const registered = options.registry.register(binding.manifest);
    if (registered.status !== "ok") throw new Error(`Could not register ${binding.manifest.name}`);
    const implementation = binding.implementation;
    if (implementation.kind !== "async") throw new TypeError("Computer companion must be async");
    const prepared = Object.freeze({ codeId: binding.manifest.entrypoint, residentBytes: 0 });
    const program: ChildWorkerProgram = {
      kind: "async",
      prepare: async () => prepared,
      drain: () => options.codeModeHost!.drain(),
      run(context) {
        const run = async (execution: import("./ChildWorkerCapacity.ts").ChildWorkerExecution) => {
          // The companion runs here; only its cells need a worker. Free the command slot first.
          await execution.handoff();
          return implementation.run(context);
        };
        const requester = { processes: context.processes, process: context.identity.handle };
        const lifetime =
          options.reservationFor === undefined
            ? options.capacity.run(context.signal, run, requester, prepared)
            : options
                .reservationFor(context, program)
                .run(context.signal, run, requester, prepared);
        lifetimes.track(lifetime);
        return lifetime;
      },
    };
    bindings.set(path, { manifest: binding.manifest, implementation: program });
  }
  return {
    bindings,
    aliases: catalog.aliases,
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
