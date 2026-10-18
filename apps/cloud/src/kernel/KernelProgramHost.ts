import { ABI_VERSION } from "./KernelAbi.ts";
import type { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import { KernelCpuExecution } from "./KernelCpuExecution.ts";
import {
  kernelError,
  type KernelBackend,
  type KernelHandle,
  type KernelResult,
  type RegisteredProgram,
  type ResolvedProgram,
} from "./KernelAbi.ts";
import { KernelProcessTable, type KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { runKernelInlineExecution } from "./process/KernelExecution.ts";
import {
  prepareKernelProgram,
  type KernelPreparedProgram,
  type KernelProgramPrepareInput,
  type KernelProgramPrepareOptions,
} from "./program/KernelPreparedProgram.ts";
import {
  preparePipedKernelProgram,
  type KernelPipedProgram,
} from "./program/KernelProgramPipes.ts";
import { KernelProgramSpawner } from "./program/KernelProgramSpawner.ts";
import {
  createKernelWasiRuntime,
  runInlineJavaScript,
  type KernelProgramBinding,
} from "./program/KernelProgramRuntime.ts";

export type { KernelExitStatus } from "./KernelProcessTable.ts";
export type {
  KernelAsyncProgram,
  KernelAsyncProgramContext,
  KernelAsyncProgramCpu,
  KernelAsyncProgramExecRequest,
} from "./KernelAsyncProgram.ts";
export type {
  KernelInlineProgram,
  KernelInlineProgramContext,
  KernelProgramBinding,
  KernelProgramImplementation,
} from "./program/KernelProgramRuntime.ts";
export type {
  KernelProgramPrepareInput,
  KernelProgramPrepareOptions,
  KernelPreparedProgram,
} from "./program/KernelPreparedProgram.ts";
export type { KernelPipedProgram } from "./program/KernelProgramPipes.ts";

export interface KernelProgramHostOptions {
  readonly registry: import("./KernelAbi.ts").KernelProgramRegistry;
  readonly programs?: ReadonlyMap<string, KernelProgramBinding>;
  readonly wakes: KernelWakeRegistry;
  readonly processes?: KernelProcessTable;
  readonly cpuAccounting?: KernelCpuAccounting;
}

type ProgramRecord = {
  readonly binding: KernelProgramBinding;
};

/** Frozen local WASI program dispatch with request-owned descriptors and processes. */
export class KernelProgramHost {
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly cpuExecution: KernelCpuExecution | undefined;
  readonly #registry: import("./KernelAbi.ts").KernelProgramRegistry;
  readonly #programs: ReadonlyMap<string, ProgramRecord>;
  readonly #resolved = new WeakMap<ResolvedProgram, ProgramRecord>();
  readonly #spawner: KernelProgramSpawner;
  readonly #resolutionBackend: KernelBackend;

  constructor(options: KernelProgramHostOptions) {
    this.#registry = options.registry;
    this.wakes = options.wakes;
    this.processes = options.processes ?? new KernelProcessTable({ wakes: options.wakes });
    this.cpuExecution =
      options.cpuAccounting === undefined
        ? undefined
        : new KernelCpuExecution(options.cpuAccounting);
    const programs = new Map<string, ProgramRecord>();
    const registeredVersions = new Set<string>();
    for (const [executable, inputBinding] of options.programs ?? []) {
      if (!executable.trim()) throw new RangeError("Program executable keys must not be empty");
      const binding = freezeBinding(inputBinding);
      const identity = `${binding.manifest.name}\0${binding.manifest.version}`;
      if (registeredVersions.has(identity)) {
        throw new RangeError("A registered program version can have only one executable mapping");
      }
      registeredVersions.add(identity);
      programs.set(executable, Object.freeze({ binding }));
    }
    this.#programs = programs;
    this.#resolutionBackend = {
      // The registry only checks callable capabilities here. Runtime dispatch
      // always uses backend(prepared), which supplies the actual child context.
      "process.spawn": () => kernelError("UNSUPPORTED", "Resolution requires a prepared process"),
      "process.wait": ({ handle }) => this.processes.wait(handle),
      "process.signal": ({ handle, signal }) =>
        this.processes.signal(handle, signal === "kill" ? 9 : 15),
    };
    this.#spawner = new KernelProgramSpawner({
      processes: this.processes,
      wakes: this.wakes,
      ...(this.cpuExecution === undefined ? {} : { cpuExecution: this.cpuExecution }),
      resolve: (executable) => this.resolve(executable),
      bindingFor: (program) => this.#resolved.get(program)?.binding,
    });
  }

  resolve(executable: string): KernelResult<ResolvedProgram> {
    const record = this.#programs.get(executable);
    if (!record) return kernelError("NOT_FOUND", "Executable is not explicitly registered locally");
    const { manifest } = record.binding;
    const result = this.#registry.resolve(
      manifest.name,
      manifest.version,
      [ABI_VERSION],
      this.#resolutionBackend,
    );
    if (result.status !== "ok") return result;
    if (!sameManifest(manifest, result.value)) {
      return kernelError(
        "INVALID_ARGUMENT",
        "Executable mapping does not match its registered manifest",
      );
    }
    this.#resolved.set(result.value, record);
    return result;
  }

  prepare(
    input: KernelProgramPrepareInput,
    options: KernelProgramPrepareOptions = {},
  ): KernelPreparedProgram {
    return prepareKernelProgram(input, options);
  }

  preparePiped(
    input: KernelProgramPrepareInput,
    options: Omit<KernelProgramPrepareOptions, "stdio"> = {},
  ): KernelPipedProgram {
    return preparePipedKernelProgram(this.wakes, input, options);
  }

  backend(prepared: KernelPreparedProgram): KernelBackend {
    return this.#spawner.backend(prepared);
  }

  async exitStatus(
    handle: KernelHandle<"process">,
    signal?: AbortSignal,
  ): Promise<KernelResult<KernelExitStatus>> {
    for (;;) {
      if (signal?.aborted) return kernelError("CANCELLED", "Process status wait cancelled");
      const result = this.processes.exitStatus(handle);
      if (result.status !== "would_block") return result;
      try {
        const woken = await this.wakes.wait(result.wakeToken, signal);
        if (woken.status !== "ok") return kernelError("CANCELLED", woken.error.message);
      } finally {
        this.wakes.release(result.wakeToken);
      }
    }
  }

  reap(handle: KernelHandle<"process">): KernelResult<void> {
    return this.processes.reap(handle);
  }

  runInline(
    prepared: KernelPreparedProgram,
    resolved: ResolvedProgram,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): number {
    const record = this.#resolved.get(resolved);
    const implementation = record?.binding.implementation;
    if (!record || implementation === undefined) {
      throw Object.assign(new Error("Inline program was not resolved by this host"), {
        code: "EINVAL",
      });
    }
    const execute = () => {
      try {
        if (implementation.kind === "javascript") {
          return runKernelInlineExecution(prepared.signal, () =>
            runInlineJavaScript(implementation.runInline, prepared, args, withHome(prepared, env)),
          );
        }
        if (implementation.kind === "async") {
          throw Object.assign(new Error("Asynchronous programs require process execution"), {
            code: "ENOTSUP",
          });
        }
        const runtime = createKernelWasiRuntime(implementation.module, {
          ...(implementation.agentOsPreopens ? { agentOsPreopens: true } : {}),
          ...(implementation.cwdEnvironment === undefined
            ? {}
            : { cwdEnvironment: implementation.cwdEnvironment }),
          prepared,
          args,
          env: withHome(prepared, env),
          asyncMode: false,
          identity: undefined,
          signal: prepared.signal,
          processes: this.processes,
          wakes: this.wakes,
          spawn: async () => kernelError("UNSUPPORTED", "Inline process spawn is asynchronous"),
        });
        return runKernelInlineExecution(prepared.signal, () =>
          runtime.lifecycle.start(runtime.instance),
        );
      } finally {
        prepared.releaseSync();
      }
    };
    const root = this.cpuExecution?.root;
    return root ? root.run(execute) : execute();
  }
}

function freezeBinding(binding: KernelProgramBinding): KernelProgramBinding {
  const manifest: RegisteredProgram = Object.freeze({
    name: binding.manifest.name,
    version: binding.manifest.version,
    abiVersion: binding.manifest.abiVersion,
    requiredCapabilities: Object.freeze([...binding.manifest.requiredCapabilities]),
    entrypoint: binding.manifest.entrypoint,
  });
  return Object.freeze({ manifest, implementation: Object.freeze(binding.implementation) });
}

function sameManifest(binding: RegisteredProgram, registered: RegisteredProgram): boolean {
  return (
    binding.name === registered.name &&
    binding.version === registered.version &&
    binding.abiVersion === registered.abiVersion &&
    binding.entrypoint === registered.entrypoint &&
    binding.requiredCapabilities.length === registered.requiredCapabilities.length &&
    binding.requiredCapabilities.every(
      (capability, index) => capability === registered.requiredCapabilities[index],
    )
  );
}

function withHome(
  context: Pick<KernelPreparedProgram, "home"> | { readonly home: string | undefined },
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (context.home === undefined || env.HOME !== undefined) return env;
  return Object.freeze({ ...env, HOME: context.home });
}
