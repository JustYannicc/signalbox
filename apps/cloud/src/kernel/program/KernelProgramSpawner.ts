import {
  callKernel,
  kernelError,
  kernelOk,
  type KernelBackend,
  type KernelHandle,
  type KernelResult,
  type ResolvedProgram,
} from "../KernelAbi.ts";
import type { AgentOsSpawnRequest } from "../AgentOsProcessWire.ts";
import type { KernelAsyncProgramExecRequest } from "../KernelAsyncProgram.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import {
  KernelProcessTable,
  type KernelLaunchedChild,
  type KernelProcessIdentity,
} from "../KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { runKernelExecution, runKernelInlineExecution } from "../process/KernelExecution.ts";
import { KernelProcessCancelledError } from "../process/KernelProcessCancellation.ts";
import { prepareKernelProgram, type KernelPreparedProgram } from "./KernelPreparedProgram.ts";
import { runKernelAsyncProgram } from "./KernelProgramExec.ts";
import {
  createKernelWasiRuntime,
  runInlineJavaScript,
  type KernelProgramBinding,
} from "./KernelProgramRuntime.ts";

interface KernelProgramSpawnerOptions {
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly resolve: (executable: string) => KernelResult<ResolvedProgram>;
  readonly bindingFor: (program: ResolvedProgram) => KernelProgramBinding | undefined;
}

type LaunchContext = {
  prepared: KernelPreparedProgram | undefined;
  lifecycle: import("../wasi/internal_wasi_lifecycle.ts").WasiLifecycle | undefined;
  detachSignal: (() => void) | undefined;
  accepted: boolean;
};

/** Process admission, nested exec and completion cleanup for prepared programs. */
export class KernelProgramSpawner {
  readonly #processes: KernelProcessTable;
  readonly #wakes: KernelWakeRegistry;
  readonly #resolve: KernelProgramSpawnerOptions["resolve"];
  readonly #bindingFor: KernelProgramSpawnerOptions["bindingFor"];

  constructor(options: KernelProgramSpawnerOptions) {
    this.#processes = options.processes;
    this.#wakes = options.wakes;
    this.#resolve = options.resolve;
    this.#bindingFor = options.bindingFor;
  }

  backend(prepared: KernelPreparedProgram): KernelBackend {
    return {
      "process.spawn": ({ program, args, env }) => {
        if (!prepared.canTransfer)
          return kernelError("ALREADY_WAITING", "Prepared program was already consumed");
        const binding = this.#bindingFor(program);
        if (!binding)
          return kernelError("INVALID_ARGUMENT", "Spawn program was not resolved by this host");
        if (!hasOnlyStringValues(env)) {
          return kernelError(
            "UNSUPPORTED",
            "Secret environment values are not supported by local WASI",
          );
        }
        return this.#spawnPrepared(prepared, binding, args, env);
      },
      "process.wait": ({ handle }) => this.#processes.wait(handle),
      "process.signal": ({ handle, signal }) =>
        this.#processes.signal(handle, signal === "kill" ? 9 : 15),
    };
  }

  #spawnPrepared(
    prepared: KernelPreparedProgram,
    binding: KernelProgramBinding,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): KernelResult<KernelHandle<"process">> {
    return this.#spawnWithFactory(
      prepared.parent,
      () => prepared,
      binding,
      args,
      withHome(prepared.home, env),
      undefined,
      false,
    );
  }

  #spawnNested(
    parentFilesystem: KernelFileSystem,
    parent: KernelHandle<"process">,
    signal: AbortSignal,
    home: string | undefined,
    request: AgentOsSpawnRequest,
  ): Promise<KernelResult<KernelHandle<"process">>> {
    // Only SETPGROUP has host semantics here; mask/default/identity changes must
    // not be accepted until the process table can actually apply them.
    // AgentOS applies this mask even without SETSIGMASK. SIGKILL and SIGSTOP
    // cannot be blocked and are removed by the pinned runner before spawning.
    const mask = request.attributes.signalMask;
    const unblockable = (1 << (9 - 1)) | (1 << (19 - 1));
    if (
      (request.attributes.flags & ~2) !== 0 ||
      (mask.low & ~unblockable) !== 0 ||
      mask.high !== 0
    ) {
      return Promise.resolve(
        kernelError("UNSUPPORTED", "Requested spawn attributes are unavailable"),
      );
    }
    const resolved = this.#resolve(request.execPath);
    if (resolved.status !== "ok") return Promise.resolve(resolved);
    const binding = this.#bindingFor(resolved.value);
    if (!binding)
      return Promise.resolve(
        kernelError("INVALID_ARGUMENT", "Resolved executable lost its mapping"),
      );
    const backend: KernelBackend = {
      "process.spawn": ({ program, args, env }) => {
        if (program !== resolved.value)
          return kernelError("INVALID_ARGUMENT", "Nested spawn changed its resolved program");
        if (!hasOnlyStringValues(env))
          return kernelError(
            "UNSUPPORTED",
            "Secret environment values are not supported by local WASI",
          );
        return this.#spawnWithFactory(
          parent,
          () =>
            prepareKernelProgram(
              {
                filesystem: parentFilesystem,
                parent,
                signal,
                ...(home === undefined ? {} : { home }),
              },
              {
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                actions: request.actions,
              },
            ),
          binding,
          args,
          withHome(home, env),
          (request.attributes.flags & 2) !== 0 ? request.attributes.processGroup : undefined,
          true,
        );
      },
      "process.wait": ({ handle }) => this.#processes.wait(handle),
      "process.signal": ({ handle, signal: requested }) =>
        this.#processes.signal(handle, requested === "kill" ? 9 : 15),
    };
    return Promise.resolve(
      callKernel(backend, "process.spawn", {
        program: resolved.value,
        args: request.argv,
        env: request.env,
      }),
    );
  }

  #spawnWithFactory(
    parent: KernelHandle<"process"> | undefined,
    prepare: () => KernelPreparedProgram,
    binding: KernelProgramBinding,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    processGroupId: number | undefined,
    releaseOnRejectedLaunch: boolean,
  ): KernelResult<KernelHandle<"process">> {
    const launch: LaunchContext = {
      prepared: undefined,
      lifecycle: undefined,
      detachSignal: undefined,
      accepted: false,
    };
    const cleanup = async () => {
      launch.detachSignal?.();
      const prepared = launch.prepared;
      if (!launch.accepted) {
        if (releaseOnRejectedLaunch && prepared) await prepared.release();
        return;
      }
      if (launch.lifecycle) {
        const errors: unknown[] = [];
        try {
          await launch.lifecycle.closeAsync();
        } catch (error) {
          errors.push(error);
        }
        try {
          prepared?.markLifecycleReleased();
        } catch (error) {
          errors.push(error);
        }
        throwCleanupErrors(errors);
      } else if (prepared) {
        await prepared.releaseTransferred();
      }
    };

    const spawned = this.#processes.spawn(
      parent,
      (identity) => {
        const prepared = prepare();
        launch.prepared = prepared;
        const controller = new AbortController();
        const parentSignal = prepared.signal;
        const abortFromParent = () => controller.abort();
        if (parentSignal?.aborted) controller.abort();
        else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
        launch.detachSignal = () => parentSignal?.removeEventListener("abort", abortFromParent);
        const child = this.#launchPrepared(
          prepared,
          binding,
          args,
          env,
          identity,
          controller,
          (request) =>
            this.#spawnNested(
              prepared.filesystem,
              identity.handle,
              controller.signal,
              prepared.home,
              request,
            ),
        );
        launch.lifecycle = child.lifecycle;
        return child.process;
      },
      cleanup,
      processGroupId === undefined ? {} : { processGroupId },
    );
    if (spawned.status !== "ok") return spawned;
    const prepared = launch.prepared;
    if (!prepared)
      return kernelError("IO_ERROR", "Process admission completed without prepared descriptors");
    try {
      prepared.transfer();
      launch.accepted = true;
      return kernelOk(spawned.value.handle);
    } catch {
      return kernelError("IO_ERROR", "Prepared process ownership could not transfer");
    }
  }

  #launchPrepared(
    prepared: KernelPreparedProgram,
    binding: KernelProgramBinding,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    identity: KernelProcessIdentity,
    controller: AbortController,
    spawn: (request: AgentOsSpawnRequest) => Promise<KernelResult<KernelHandle<"process">>>,
  ): {
    readonly process: KernelLaunchedChild;
    readonly lifecycle?: import("../wasi/internal_wasi_lifecycle.ts").WasiLifecycle;
  } {
    let sentSignal = 0;
    const implementation = binding.implementation;
    const signal = (number: number): KernelResult<void> => {
      if (number !== 9 && number !== 15)
        return kernelError("UNSUPPORTED", "Only terminate and kill are supported");
      sentSignal = number;
      controller.abort();
      return kernelOk(undefined);
    };
    if (implementation.kind === "javascript") {
      const completion = Promise.resolve().then(() => {
        if (controller.signal.aborted) return terminatedStatus(sentSignal);
        try {
          const exitCode = runKernelInlineExecution(controller.signal, () =>
            runInlineJavaScript(implementation.runInline, prepared, args, env),
          );
          return controller.signal.aborted
            ? terminatedStatus(sentSignal)
            : { exitCode, signal: 0, coreDumped: false };
        } catch (error) {
          if (controller.signal.aborted) return terminatedStatus(sentSignal);
          throw error;
        }
      });
      return { process: { completion, signal } };
    }

    if (implementation.kind === "async") {
      const spawnFor =
        (
          context: Pick<
            KernelAsyncProgramExecRequest,
            "filesystem" | "identity" | "signal" | "home"
          >,
        ) =>
        (request: AgentOsSpawnRequest) =>
          this.#spawnNested(
            context.filesystem,
            context.identity.handle,
            context.signal,
            context.home,
            request,
          );
      const context = {
        filesystem: prepared.filesystem,
        home: prepared.home,
        args: Object.freeze([...args]),
        env: Object.freeze({ ...env }),
        identity,
        signal: controller.signal,
        processes: this.#processes,
        wakes: this.#wakes,
        spawn: spawnFor({
          filesystem: prepared.filesystem,
          identity,
          signal: controller.signal,
          ...(prepared.home === undefined ? {} : { home: prepared.home }),
        }),
      };
      const completion = runKernelExecution(controller.signal, async () => {
        if (controller.signal.aborted) return terminatedStatus(sentSignal);
        try {
          const exit = await runKernelAsyncProgram(implementation.run, context, {
            resolve: this.#resolve,
            bindingFor: this.#bindingFor,
            processes: this.#processes,
            wakes: this.#wakes,
            spawnFor,
          });
          return controller.signal.aborted ? terminatedStatus(sentSignal) : exit;
        } catch (error) {
          if (controller.signal.aborted) return terminatedStatus(sentSignal);
          throw error;
        }
      });
      return { process: { completion, signal } };
    }

    const runtime = createKernelWasiRuntime(implementation.module, {
      prepared,
      args,
      env,
      asyncMode: true,
      identity,
      signal: controller.signal,
      processes: this.#processes,
      wakes: this.#wakes,
      spawn,
    });
    const completion = runKernelExecution(controller.signal, () =>
      runtime.lifecycle.startAsync(runtime.instance),
    ).then(
      (exitCode) =>
        controller.signal.aborted
          ? terminatedStatus(sentSignal)
          : { exitCode, signal: 0, coreDumped: false },
      (error: unknown) => {
        if (controller.signal.aborted) return terminatedStatus(sentSignal);
        throw error;
      },
    );
    return { process: { completion, signal }, lifecycle: runtime.lifecycle };
  }
}

function withHome(
  home: string | undefined,
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (home === undefined || env.HOME !== undefined) return env;
  return Object.freeze({ ...env, HOME: home });
}

function terminatedStatus(signal: number) {
  if (signal === 0) throw new KernelProcessCancelledError("Parent process was cancelled");
  return { exitCode: 0, signal, coreDumped: false };
}

function hasOnlyStringValues(
  env: Readonly<Record<string, string | KernelHandle<"secret">>>,
): env is Readonly<Record<string, string>> {
  return Object.values(env).every((value) => typeof value === "string");
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Prepared process cleanup failed");
}
