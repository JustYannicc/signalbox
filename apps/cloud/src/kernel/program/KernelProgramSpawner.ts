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
import {
  captureKernelProgramSpawnAdmission,
  createKernelProgramSpawnAdmissionRequest,
  type KernelProgramAdmissionDecision,
  type KernelProgramAdmissionRequest,
  type KernelProgramSpawnAdmissionCapture,
} from "../KernelProgramAdmission.ts";
import type {
  KernelAsyncProgramCpu,
  KernelAsyncProgramExecRequest,
} from "../KernelAsyncProgram.ts";
import type { KernelFileByteSelection } from "../KernelFileBytes.ts";
import type { KernelCommand } from "../KernelCommandForwarder.ts";
import { KernelProcessSignal, kernelProcessSignalExitStatus } from "../KernelProcessSignal.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import {
  KernelProcessTable,
  type KernelLaunchedChild,
  type KernelProcessIdentity,
  type KernelSignalMask,
} from "../KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { KernelCpuExecution, type KernelCpuProcessExecution } from "../KernelCpuExecution.ts";
import { runKernelExecution, runKernelInlineExecution } from "../process/KernelExecution.ts";
import { KernelProcessCancelledError } from "../process/KernelProcessCancellation.ts";
import {
  prepareKernelProgram,
  type KernelPreparedProgram,
  type KernelProgramPrepareInput,
  type KernelProgramPrepareOptions,
} from "./KernelPreparedProgram.ts";
import { spawnKernelCommandPiped } from "./KernelProgramCommandSpawn.ts";
import {
  assertKernelFileByteSelectionCompatible,
  commitKernelProgramFileBytes,
  resolveKernelProgramFileBytes,
  type KernelPreparedFileByteSelection,
  type KernelProgramFileByteSelector,
} from "./KernelProgramFileBytes.ts";
import { runKernelAsyncProgram } from "./KernelProgramExec.ts";
import {
  createKernelWasiRuntime,
  runInlineJavaScript,
  type KernelProgramBinding,
  type KernelProgramImplementation,
} from "./KernelProgramRuntime.ts";
import { KernelProgramAdmissionTicket } from "./KernelProgramAdmissionTicket.ts";

interface KernelProgramSpawnerOptions {
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly cpuExecution?: KernelCpuExecution;
  readonly resolve: (executable: string) => KernelResult<ResolvedProgram>;
  readonly bindingFor: (program: ResolvedProgram) => KernelProgramBinding | undefined;
  readonly executableFor: (program: ResolvedProgram) => string | undefined;
  readonly selectFileBytes?: KernelProgramFileByteSelector;
  readonly admit?: (
    request: KernelProgramAdmissionRequest,
  ) => Promise<KernelProgramAdmissionDecision>;
}

type LaunchContext = {
  prepared: KernelPreparedProgram | undefined;
  lifecycle: import("../wasi/internal_wasi_lifecycle.ts").WasiLifecycle | undefined;
  cpuProcess: KernelCpuProcessExecution | undefined;
  detachSignal: (() => void) | undefined;
  accepted: boolean;
};

/** Process admission, nested exec and completion cleanup for prepared programs. */
export class KernelProgramSpawner {
  readonly #processes: KernelProcessTable;
  readonly #wakes: KernelWakeRegistry;
  readonly #cpuExecution: KernelCpuExecution | undefined;
  readonly #resolve: KernelProgramSpawnerOptions["resolve"];
  readonly #bindingFor: KernelProgramSpawnerOptions["bindingFor"];
  readonly #executableFor: KernelProgramSpawnerOptions["executableFor"];
  readonly #selectFileBytes: KernelProgramFileByteSelector | undefined;
  readonly #admit: KernelProgramSpawnerOptions["admit"];

  constructor(options: KernelProgramSpawnerOptions) {
    this.#processes = options.processes;
    this.#wakes = options.wakes;
    this.#cpuExecution = options.cpuExecution;
    this.#resolve = options.resolve;
    this.#bindingFor = options.bindingFor;
    this.#executableFor = options.executableFor;
    this.#selectFileBytes = options.selectFileBytes;
    this.#admit = options.admit;
  }

  backend(
    prepared: KernelPreparedProgram,
    preselected?: KernelPreparedFileByteSelection,
  ): KernelBackend {
    return {
      "process.spawn": ({ program, args, env }) => {
        if (!prepared.canTransfer)
          return kernelError("ALREADY_WAITING", "Prepared program was already consumed");
        const binding = this.#bindingFor(program);
        if (!binding)
          return kernelError("INVALID_ARGUMENT", "Spawn program was not resolved by this host");
        const executable = this.#executableFor(program);
        if (executable === undefined)
          return kernelError("INVALID_ARGUMENT", "Spawn program lost its executable mapping");
        if (!hasOnlyStringValues(env)) {
          return kernelError(
            "UNSUPPORTED",
            "Secret environment values are not supported by local WASI",
          );
        }
        return this.#spawnPrepared(prepared, executable, binding, args, env, preselected);
      },
      "process.wait": ({ handle }) => this.#processes.wait(handle),
      "process.signal": ({ handle, signal }) =>
        this.#processes.signal(handle, signal === "kill" ? 9 : 15),
    };
  }

  spawn(
    filesystem: KernelFileSystem,
    parent: KernelHandle<"process">,
    signal: AbortSignal,
    home: string | undefined,
    request: AgentOsSpawnRequest,
    admission?: object,
  ): Promise<KernelResult<KernelHandle<"process">>> {
    return this.#spawnNested(filesystem, parent, signal, home, request, admission);
  }

  spawnCommandPiped(
    input: KernelProgramPrepareInput,
    command: KernelCommand,
    options: Pick<KernelProgramPrepareOptions, "fileBytes">,
  ) {
    return spawnKernelCommandPiped(input, command, options, {
      processes: this.#processes,
      wakes: this.#wakes,
      resolve: this.#resolve,
      bindingFor: this.#bindingFor,
      ...(this.#selectFileBytes === undefined ? {} : { selectFileBytes: this.#selectFileBytes }),
      ...(this.#admit === undefined ? {} : { admit: this.#admit }),
      launch: (prepared, implementation, captured, ticket) =>
        this.#spawnWithFactory(
          prepared.parent,
          () => {
            commitKernelProgramFileBytes(prepared.filesystem, prepared.filesystem.fileBytes);
            return prepared;
          },
          implementation,
          captured.argv,
          captured.env,
          undefined,
          true,
          undefined,
          ticket,
          true,
        ),
    });
  }

  #spawnPrepared(
    prepared: KernelPreparedProgram,
    executable: string,
    binding: KernelProgramBinding,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    preselected?: KernelPreparedFileByteSelection,
  ): KernelResult<KernelHandle<"process">> {
    let fileBytes: KernelFileByteSelection;
    try {
      if (preselected?.executable !== undefined && preselected.executable !== executable) {
        return kernelError(
          "INVALID_ARGUMENT",
          "Prepared program target does not match spawn target",
        );
      }
      fileBytes = resolveKernelProgramFileBytes({
        executable,
        ...(preselected === undefined ? {} : { explicitSelection: preselected.selection }),
        ...(this.#selectFileBytes === undefined ? {} : { selector: this.#selectFileBytes }),
        filesystem: prepared.filesystem,
        ...(prepared.parent === undefined ? {} : { parent: prepared.parent }),
      });
      assertKernelFileByteSelectionCompatible(prepared.filesystem.descriptors.entries(), fileBytes);
    } catch (error) {
      return fileByteSelectionError(error);
    }
    return this.#spawnWithFactory(
      prepared.parent,
      () => {
        commitKernelProgramFileBytes(prepared.filesystem, fileBytes);
        return prepared;
      },
      binding.implementation,
      args,
      withHome(prepared.home, env),
      undefined,
      false,
      undefined,
    );
  }

  #spawnNested(
    parentFilesystem: KernelFileSystem,
    parent: KernelHandle<"process">,
    signal: AbortSignal,
    home: string | undefined,
    request: AgentOsSpawnRequest,
    admission?: object,
  ): Promise<KernelResult<KernelHandle<"process">>> {
    const capture = captureKernelProgramSpawnAdmission({
      filesystem: parentFilesystem,
      processes: this.#processes,
      parent,
      signal,
      home,
      request,
      admission,
    });
    // AgentOS passes the authoritative mask even without SETSIGMASK. Default
    // disposition and identity changes still have no host implementation.
    if ((capture.attributes.flags & ~(2 | 8)) !== 0) {
      return Promise.resolve(
        kernelError("UNSUPPORTED", "Requested spawn attributes are unavailable"),
      );
    }
    if (this.#admit && signal.aborted) {
      return Promise.resolve(kernelError("CANCELLED", "Process spawn cancelled"));
    }
    const resolved = this.#resolve(capture.command.executable);
    if (resolved.status === "would_block") return Promise.resolve(resolved);
    let target: KernelProgramAdmissionRequest["target"];
    if (resolved.status === "ok") {
      const binding = this.#bindingFor(resolved.value);
      if (!binding) {
        return Promise.resolve(
          kernelError("INVALID_ARGUMENT", "Resolved executable lost its mapping"),
        );
      }
      target = Object.freeze({ kind: "resolved", program: resolved.value, binding });
    } else if (
      this.#admit &&
      (resolved.error.code === "NOT_FOUND" || resolved.error.code === "UNSUPPORTED")
    ) {
      target = Object.freeze({
        kind: "unsupported",
        code: resolved.error.code,
        message: resolved.error.message,
      });
    } else {
      return Promise.resolve(resolved);
    }
    const admissionRequest = createKernelProgramSpawnAdmissionRequest(capture, target);
    const launchCapture: CapturedSpawnRequest = Object.freeze({
      ...admissionRequest,
      attributes: capture.attributes,
      parent: capture.parent,
      pidPointer: capture.pidPointer,
      ...(capture.requestedCwd === undefined ? {} : { requestedCwd: capture.requestedCwd }),
    });

    const launch = (
      implementation: KernelProgramImplementation,
      selectedAdmission: object | undefined,
      route: "local" | "forward",
      ticket: KernelProgramAdmissionTicket | undefined,
    ) =>
      this.#launchAdmittedSpawn(
        parentFilesystem,
        launchCapture,
        implementation,
        selectedAdmission,
        route,
        ticket,
      );

    if (this.#admit) {
      let ticket: KernelProgramAdmissionTicket | undefined;
      return this.#admit(admissionRequest)
        .then((candidate) => {
          ticket = KernelProgramAdmissionTicket.from(admissionRequest, candidate);
          const selection = ticket.resume();
          if (selection.kind === "unsupported") {
            ticket.throwCancelFailure();
            return kernelError(selection.code, selection.message);
          }
          if (signal.aborted) {
            ticket.cancel();
            ticket.throwCancelFailure();
            return kernelError("CANCELLED", "Process spawn cancelled");
          }
          ticket.assertCurrent();
          return launch(selection.implementation, selection.admission, selection.route, ticket);
        })
        .catch((error: unknown) => {
          ticket?.cancel();
          ticket?.throwCancelFailure();
          throw error;
        });
    }

    if (target.kind === "unsupported") {
      return Promise.resolve(kernelError(target.code, target.message));
    }
    return launch(target.binding.implementation, capture.admission, "local", undefined);
  }

  #launchAdmittedSpawn(
    parentFilesystem: KernelFileSystem,
    capture: CapturedSpawnRequest,
    implementation: KernelProgramImplementation,
    admission: object | undefined,
    route: "local" | "forward",
    ticket: KernelProgramAdmissionTicket | undefined,
  ): Promise<KernelResult<KernelHandle<"process">>> {
    let fileBytes: KernelFileByteSelection;
    try {
      fileBytes = resolveKernelProgramFileBytes({
        executable: capture.command.executable,
        ...(this.#selectFileBytes === undefined ? {} : { selector: this.#selectFileBytes }),
        filesystem: parentFilesystem,
        parent: capture.parent,
      });
    } catch (error) {
      ticket?.cancel();
      ticket?.throwCancelFailure();
      return Promise.resolve(fileByteSelectionError(error));
    }
    // Admission can wait while the parent changes cwd. Relative requests retain their captured base.
    const cwd = ticket === undefined ? capture.requestedCwd : capture.baseCwd;
    const actions =
      ticket !== undefined && capture.requestedCwd !== undefined
        ? [
            {
              kind: "chdir" as const,
              fd: 0,
              sourceFd: 0,
              flags: 0,
              mode: 0,
              path: capture.requestedCwd,
            },
            ...capture.actions,
          ]
        : capture.actions;
    const launch = (args: readonly string[], env: Readonly<Record<string, string>>) =>
      this.#spawnWithFactory(
        capture.parent,
        () =>
          prepareKernelProgram(
            {
              filesystem: parentFilesystem,
              parent: capture.parent,
              signal: capture.signal,
              ...(capture.home === undefined ? {} : { home: capture.home }),
              ...(admission === undefined ? {} : { admission }),
            },
            {
              ...(cwd === undefined ? {} : { cwd }),
              actions,
              fileBytes,
            },
          ),
        implementation,
        args,
        ticket === undefined ? withHome(capture.home, env) : env,
        (capture.attributes.flags & 2) !== 0 ? capture.attributes.processGroup : undefined,
        true,
        capture.attributes.signalMask,
        ticket,
        ticket !== undefined,
      );

    if (ticket !== undefined) {
      return Promise.resolve(launch(capture.command.argv, capture.command.env));
    }
    if (capture.target.kind !== "resolved") {
      return Promise.resolve(kernelError(capture.target.code, capture.target.message));
    }
    const resolvedTarget = capture.target;
    if (route === "forward") throw new TypeError("Forwarded program requires an admission ticket");
    const backend: KernelBackend = {
      "process.spawn": ({ program, args, env }) => {
        if (program !== resolvedTarget.program)
          return kernelError("INVALID_ARGUMENT", "Nested spawn changed its resolved program");
        if (!hasOnlyStringValues(env))
          return kernelError(
            "UNSUPPORTED",
            "Secret environment values are not supported by local WASI",
          );
        return launch(args, env);
      },
      "process.wait": ({ handle }) => this.#processes.wait(handle),
      "process.signal": ({ handle, signal: requested }) =>
        this.#processes.signal(handle, requested === "kill" ? 9 : 15),
    };
    return Promise.resolve(
      callKernel(backend, "process.spawn", {
        program: resolvedTarget.program,
        args: capture.command.argv,
        env: capture.command.env,
      }),
    );
  }

  #spawnWithFactory(
    parent: KernelHandle<"process"> | undefined,
    prepare: () => KernelPreparedProgram,
    implementation: KernelProgramImplementation,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    processGroupId: number | undefined,
    releaseOnRejectedLaunch: boolean,
    signalMask?: KernelSignalMask,
    ticket?: KernelProgramAdmissionTicket,
    preserveEnvIdentity = false,
  ): KernelResult<KernelHandle<"process">> {
    const launch: LaunchContext = {
      prepared: undefined,
      lifecycle: undefined,
      cpuProcess: undefined,
      detachSignal: undefined,
      accepted: false,
    };
    const cleanup = () => {
      const finish = async () => {
        const errors: unknown[] = [];
        try {
          launch.detachSignal?.();
          const prepared = launch.prepared;
          if (!launch.accepted) {
            if (releaseOnRejectedLaunch && prepared) await prepared.release();
          } else if (launch.lifecycle) {
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
          } else if (prepared) {
            await prepared.releaseTransferred();
          }
        } catch (error) {
          errors.push(error);
        } finally {
          try {
            ticket?.cancel();
            ticket?.throwCancelFailure();
          } catch (error) {
            errors.push(error);
          }
          try {
            launch.cpuProcess?.stop();
          } catch (error) {
            errors.push(error);
          }
        }
        throwCleanupErrors(errors);
      };
      return launch.cpuProcess ? launch.cpuProcess.run(finish) : finish();
    };
    let preparationFailure: unknown;

    const spawned = this.#processes.spawn(
      parent,
      (identity) => {
        let prepared: KernelPreparedProgram;
        try {
          prepared = prepare();
          launch.prepared = prepared;
        } catch (error) {
          preparationFailure = error;
          throw error;
        }
        const cpuProcess = this.#cpuExecution?.forProcess(identity.pid);
        launch.cpuProcess = cpuProcess;
        const controller = new AbortController();
        const parentSignal = prepared.signal;
        const abortFromParent = () => controller.abort(parentSignal?.reason);
        if (parentSignal?.aborted) controller.abort(parentSignal.reason);
        else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
        launch.detachSignal = () => parentSignal?.removeEventListener("abort", abortFromParent);
        const child = this.#launchPrepared(
          prepared,
          implementation,
          args,
          env,
          identity,
          cpuProcess,
          controller,
          ticket,
          preserveEnvIdentity,
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
      {
        ...(processGroupId === undefined ? {} : { processGroupId }),
        ...(signalMask === undefined ? {} : { signalMask }),
      },
    );
    if (spawned.status !== "ok") {
      ticket?.cancel();
      ticket?.throwCancelFailure();
      return preparationFailure === undefined
        ? spawned
        : processPreparationError(preparationFailure);
    }
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
    implementation: KernelProgramImplementation,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    identity: KernelProcessIdentity,
    cpuProcess: KernelCpuProcessExecution | undefined,
    controller: AbortController,
    ticket: KernelProgramAdmissionTicket | undefined,
    preserveEnvIdentity: boolean,
    spawn: (request: AgentOsSpawnRequest) => Promise<KernelResult<KernelHandle<"process">>>,
  ): {
    readonly process: KernelLaunchedChild;
    readonly lifecycle?: import("../wasi/internal_wasi_lifecycle.ts").WasiLifecycle;
  } {
    const disposition = this.#processes.setSigpipeDisposition(
      identity.handle,
      implementation.sigpipe ?? "terminate",
    );
    if (disposition.status !== "ok") throw new Error("Process signal state is unavailable");
    let sentSignal = 0;
    const beginBody = () =>
      ticket === undefined ? !controller.signal.aborted : ticket.beginBody(controller.signal);
    const signal = (number: number): KernelResult<void> => {
      if (number !== 9 && number !== 15)
        return kernelError("UNSUPPORTED", "Only terminate and kill are supported");
      sentSignal = number;
      controller.abort(new KernelProcessSignal(number));
      return kernelOk(undefined);
    };
    if (implementation.kind === "javascript") {
      const start = () =>
        Promise.resolve().then(() => {
          if (!beginBody()) return terminatedStatus(sentSignal);
          try {
            const exitCode = runKernelInlineExecution(controller.signal, () => {
              const runInline = () =>
                runInlineJavaScript(implementation.runInline, prepared, args, env);
              return cpuProcess ? cpuProcess.runUser(runInline) : runInline();
            });
            return controller.signal.aborted
              ? terminatedStatus(sentSignal)
              : { exitCode, signal: 0, coreDumped: false };
          } catch (error) {
            if (controller.signal.aborted) return terminatedStatus(sentSignal);
            return kernelProcessSignalExitStatus(error);
          }
        });
      const completion = cpuProcess ? cpuProcess.run(start) : start();
      return { process: { completion, signal, supportedSignals: [9, 15] } };
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
        args: preserveEnvIdentity ? args : Object.freeze([...args]),
        env: preserveEnvIdentity ? env : Object.freeze({ ...env }),
        identity,
        signal: controller.signal,
        processes: this.#processes,
        wakes: this.#wakes,
        ...(prepared.admission === undefined ? {} : { admission: prepared.admission }),
        ...(cpuProcess === undefined || this.#cpuExecution === undefined
          ? {}
          : { cpu: createAsyncProgramCpu(this.#cpuExecution, cpuProcess) }),
        spawn: spawnFor({
          filesystem: prepared.filesystem,
          identity,
          signal: controller.signal,
          ...(prepared.home === undefined ? {} : { home: prepared.home }),
        }),
      };
      const start = () =>
        runKernelExecution(controller.signal, () =>
          Promise.resolve().then(async () => {
            if (!beginBody()) return terminatedStatus(sentSignal);
            try {
              const exit = await runKernelAsyncProgram(implementation.run, context, {
                resolve: this.#resolve,
                bindingFor: this.#bindingFor,
                processes: this.#processes,
                wakes: this.#wakes,
                spawnFor,
                ...(this.#selectFileBytes === undefined
                  ? {}
                  : { selectFileBytes: this.#selectFileBytes }),
                ...(this.#admit === undefined ? {} : { admit: this.#admit }),
              });
              return controller.signal.aborted ? terminatedStatus(sentSignal) : exit;
            } catch (error) {
              if (controller.signal.aborted) return terminatedStatus(sentSignal);
              return kernelProcessSignalExitStatus(error);
            }
          }),
        );
      const completion = cpuProcess ? cpuProcess.run(start) : start();
      return { process: { completion, signal, supportedSignals: [9, 15] } };
    }

    const runtime = createKernelWasiRuntime(implementation.module, {
      ...(implementation.sigpipe === undefined ? {} : { sigpipe: implementation.sigpipe }),
      ...(implementation.agentOsPreopens ? { agentOsPreopens: true } : {}),
      ...(implementation.cwdEnvironment === undefined
        ? {}
        : { cwdEnvironment: implementation.cwdEnvironment }),
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
    const start = () => {
      if (ticket !== undefined && !beginBody()) {
        return Promise.resolve(terminatedStatus(sentSignal));
      }
      return runKernelExecution(controller.signal, () =>
        runtime.lifecycle.startAsync(runtime.instance),
      ).then(
        (exitCode) =>
          controller.signal.aborted
            ? terminatedStatus(sentSignal)
            : { exitCode, signal: 0, coreDumped: false },
        (error: unknown) => {
          if (controller.signal.aborted) return terminatedStatus(sentSignal);
          return kernelProcessSignalExitStatus(error);
        },
      );
    };
    const completion = cpuProcess ? cpuProcess.run(start) : start();
    return {
      process: { completion, signal, supportedSignals: [9, 15] },
      lifecycle: runtime.lifecycle,
    };
  }
}

type CapturedSpawnRequest = KernelProgramAdmissionRequest &
  Pick<KernelProgramSpawnAdmissionCapture, "attributes" | "parent" | "pidPointer" | "requestedCwd">;

function withHome(
  home: string | undefined,
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (home === undefined || env.HOME !== undefined) return env;
  return Object.freeze({ ...env, HOME: home });
}

function createAsyncProgramCpu(
  execution: KernelCpuExecution,
  cpuProcess: KernelCpuProcessExecution,
): KernelAsyncProgramCpu {
  const cpu: KernelAsyncProgramCpu = Object.freeze({
    run: <T>(run: () => T): T => cpuProcess.run(run),
    runUser: <T>(run: () => T): T => cpuProcess.runUser(run),
    forProcess: (pid: number): KernelAsyncProgramCpu =>
      pid === cpuProcess.pid ? cpu : createAsyncProgramCpu(execution, execution.forProcess(pid)),
    stop: () => {
      cpuProcess.stop();
    },
  });
  return cpu;
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

function fileByteSelectionError(error: unknown): KernelResult<KernelHandle<"process">> {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : "File byte selection failed";
  return kernelError(code === "ENOTSUP" ? "UNSUPPORTED" : "IO_ERROR", message);
}

function processPreparationError(error: unknown): KernelResult<KernelHandle<"process">> {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return code === "ENOTSUP"
    ? kernelError(
        "UNSUPPORTED",
        error instanceof Error ? error.message : "Process preparation is unsupported",
      )
    : kernelError("IO_ERROR", "Process launch failed");
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Prepared process cleanup failed");
}
