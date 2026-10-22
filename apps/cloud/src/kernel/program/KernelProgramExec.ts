import { type KernelHandle, type KernelResult, type ResolvedProgram } from "../KernelAbi.ts";
import type {
  KernelAsyncProgramContext,
  KernelAsyncProgramCpu,
  KernelAsyncProgramExecRequest,
} from "../KernelAsyncProgram.ts";
import type {
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "../KernelProgramAdmission.ts";
import {
  captureKernelProgramExecAdmission,
  createKernelProgramExecAdmissionRequest,
} from "../KernelProgramAdmission.ts";
import { KernelProgramExecAdmissionError } from "../KernelAsyncProgram.ts";
import type { AgentOsSpawnRequest } from "../AgentOsProcessWire.ts";
import type { KernelExitStatus, KernelProcessTable } from "../KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { enterCurrentKernelCpuUser } from "../KernelCpuExecution.ts";
import { runKernelExecution, runKernelInlineExecution } from "../process/KernelExecution.ts";
import { KernelProcessCancelledError } from "../process/KernelProcessCancellation.ts";
import { kernelProcessSignalExitStatus } from "../KernelProcessSignal.ts";
import { runSync } from "../wasi/internal_wasi_calls.ts";
import {
  prepareKernelWasiRuntime,
  runInlineJavaScript,
  type KernelProgramBinding,
  type KernelProgramImplementation,
} from "./KernelProgramRuntime.ts";
import type { KernelFileByteSelection } from "../KernelFileBytes.ts";
import type { KernelProgramFileByteSelector } from "./KernelProgramFileBytes.ts";
import {
  assertKernelFileByteSelectionCompatible,
  commitKernelProgramFileBytes,
  resolveKernelProgramFileBytes,
} from "./KernelProgramFileBytes.ts";
import { KernelProgramAdmissionTicket } from "./KernelProgramAdmissionTicket.ts";

export interface KernelProgramExecOptions {
  readonly resolve: (path: string) => KernelResult<ResolvedProgram>;
  readonly bindingFor: (program: ResolvedProgram) => KernelProgramBinding | undefined;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly selectFileBytes?: KernelProgramFileByteSelector;
  readonly admit?: (
    request: KernelProgramAdmissionRequest,
  ) => Promise<KernelProgramAdmissionDecision>;
  readonly spawnFor: (
    context: Pick<KernelAsyncProgramExecRequest, "filesystem" | "identity" | "signal" | "home">,
  ) => (request: AgentOsSpawnRequest) => Promise<KernelResult<KernelHandle<"process">>>;
}

export type KernelAsyncProgramBaseContext = Omit<KernelAsyncProgramContext, "exec">;

export function runKernelAsyncProgram(
  run: (context: KernelAsyncProgramContext) => Promise<KernelExitStatus>,
  context: KernelAsyncProgramBaseContext,
  options: KernelProgramExecOptions,
): Promise<KernelExitStatus> {
  const completeContext: KernelAsyncProgramContext = Object.freeze({
    ...context,
    exec: (request: KernelAsyncProgramExecRequest) =>
      execKernelProgram(request, options, context.cpu?.forProcess(request.identity.pid)),
  });
  const leaveUser = enterCurrentKernelCpuUser();
  let result: Promise<KernelExitStatus>;
  try {
    result = Promise.resolve(run(completeContext));
    // Accounting cleanup can fail before the process can await its result.
    void result.catch(() => undefined);
  } finally {
    leaveUser();
  }
  return result.then(validateStatus);
}

/** Replaces the current program while retaining its PID and descriptor table. */
export function execKernelProgram(
  request: KernelAsyncProgramExecRequest,
  options: KernelProgramExecOptions,
  cpu?: KernelAsyncProgramCpu,
): Promise<KernelExitStatus> {
  const captured =
    options.admit === undefined
      ? undefined
      : captureKernelProgramExecAdmission(request, options.processes);
  return runKernelExecution(request.signal, async () => {
    if (request.signal.aborted)
      throw new KernelProcessCancelledError("Program execution cancelled");
    const command = captured?.command;
    const path = command?.executable ?? request.path;
    const args = command?.argv ?? request.args;
    const rawEnv = command?.env ?? request.env;
    let ticket: KernelProgramAdmissionTicket | undefined;
    try {
      const resolved = beforeExecCommit(() => options.resolve(path));
      let target: KernelProgramAdmissionRequest["target"];
      if (resolved.status === "would_block") {
        throw new KernelProgramExecAdmissionError("EAGAIN", "Program resolution would block");
      }
      if (resolved.status === "error") {
        if (resolved.error.code === "CANCELLED") {
          throw new KernelProcessCancelledError(resolved.error.message);
        }
        if (
          options.admit !== undefined &&
          (resolved.error.code === "NOT_FOUND" || resolved.error.code === "UNSUPPORTED")
        ) {
          target = Object.freeze({
            kind: "unsupported",
            code: resolved.error.code,
            message: resolved.error.message,
          });
        } else {
          throw new KernelProgramExecAdmissionError(
            kernelCodeToErrno(resolved.error.code),
            resolved.error.message,
          );
        }
      } else {
        const binding = beforeExecCommit(() => options.bindingFor(resolved.value));
        if (!binding) {
          throw new KernelProgramExecAdmissionError(
            "EIO",
            "Resolved program lost its implementation",
          );
        }
        target = Object.freeze({ kind: "resolved", program: resolved.value, binding });
      }

      let implementation: KernelProgramImplementation;
      let selectedAdmission = options.admit === undefined ? request.admission : undefined;
      if (options.admit !== undefined) {
        const admissionRequest = createKernelProgramExecAdmissionRequest(captured!, target);
        let candidate: KernelProgramAdmissionDecision;
        try {
          candidate = await options.admit(admissionRequest);
        } catch (error) {
          if (request.signal.aborted) {
            throw new KernelProcessCancelledError("Program execution cancelled");
          }
          throw beforeExecCommit(() => {
            throw error;
          });
        }
        try {
          ticket = KernelProgramAdmissionTicket.from(admissionRequest, candidate);
        } catch (error) {
          throw beforeExecCommit(() => {
            throw error;
          });
        }
        if (request.signal.aborted) {
          ticket.cancel();
          ticket.throwCancelFailure();
          throw new KernelProcessCancelledError("Program execution cancelled");
        }
        const selection = beforeExecCommit(() => ticket!.resume());
        if (selection.kind === "unsupported") {
          throw new KernelProgramExecAdmissionError(
            kernelCodeToErrno(selection.code),
            selection.message,
          );
        }
        implementation = selection.implementation;
        selectedAdmission = selection.admission;
        beforeExecCommit(() => ticket!.assertCurrent());
      } else {
        if (target.kind === "unsupported") {
          throw new KernelProgramExecAdmissionError(kernelCodeToErrno(target.code), target.message);
        }
        implementation = target.binding.implementation;
      }

      const executionRequest: KernelAsyncProgramExecRequest =
        captured === undefined
          ? request
          : Object.freeze({
              filesystem: captured.filesystem,
              identity: captured.identity!,
              args,
              env: rawEnv,
              signal: captured.signal,
              path,
              ...(captured.home === undefined ? {} : { home: captured.home }),
              ...(selectedAdmission === undefined ? {} : { admission: selectedAdmission }),
            });
      const prepared = {
        filesystem: executionRequest.filesystem,
        home: executionRequest.home,
      };
      const spawn = beforeExecCommit(() =>
        options.spawnFor({
          filesystem: executionRequest.filesystem,
          identity: executionRequest.identity,
          signal: executionRequest.signal,
          ...(executionRequest.home === undefined ? {} : { home: executionRequest.home }),
        }),
      );
      const fileBytes: KernelFileByteSelection = beforeExecCommit(() =>
        resolveKernelProgramFileBytes({
          executable: path,
          ...(options.selectFileBytes === undefined ? {} : { selector: options.selectFileBytes }),
          filesystem: executionRequest.filesystem,
          parent: executionRequest.identity.handle,
        }),
      );
      beforeExecCommit(() =>
        assertKernelFileByteSelectionCompatible(
          executionRequest.filesystem.descriptors.entries(),
          fileBytes,
          {
            survivingOnly: true,
          },
        ),
      );
      const env =
        ticket === undefined
          ? environmentWithHome(executionRequest.home, executionRequest.env)
          : executionRequest.env;
      if (implementation.kind === "wasm") {
        // Validate every import before CLOEXEC descriptors are removed.
        const runtime = beforeExecCommit(() =>
          prepareKernelWasiRuntime(implementation.module, {
            ...(implementation.sigpipe === undefined ? {} : { sigpipe: implementation.sigpipe }),
            ...(implementation.agentOsPreopens ? { agentOsPreopens: true } : {}),
            ...(implementation.cwdEnvironment === undefined
              ? {}
              : { cwdEnvironment: implementation.cwdEnvironment }),
            prepared,
            descriptorOwnership: "borrowed",
            args,
            env,
            asyncMode: true,
            identity: executionRequest.identity,
            signal: executionRequest.signal,
            processes: options.processes,
            wakes: options.wakes,
            spawn,
          }),
        );
        try {
          return await afterExecCommit(async () => {
            if (executionRequest.signal.aborted)
              throw new KernelProcessCancelledError("Program execution cancelled");
            sweepCloseOnExec(executionRequest);
            commitKernelProgramFileBytes(executionRequest.filesystem, fileBytes);
            const exitCode = await runtime.lifecycle.startAsync(runtime.instantiate());
            return status(exitCode);
          }).finally(() => cancelTicket(ticket));
        } finally {
          await runtime.lifecycle.closeAsync();
        }
      }

      if (implementation.kind === "javascript") {
        return await afterExecCommit(() => {
          if (executionRequest.signal.aborted)
            throw new KernelProcessCancelledError("Program execution cancelled");
          sweepCloseOnExec(executionRequest);
          commitKernelProgramFileBytes(executionRequest.filesystem, fileBytes);
          const exitCode = runKernelInlineExecution(executionRequest.signal, () =>
            runInlineJavaScript(implementation.runInline, prepared, args, env),
          );
          if (executionRequest.signal.aborted) {
            throw new KernelProcessCancelledError("Program execution cancelled");
          }
          return status(exitCode);
        }).finally(() => cancelTicket(ticket));
      }

      return await afterExecCommit(async () => {
        if (executionRequest.signal.aborted)
          throw new KernelProcessCancelledError("Program execution cancelled");
        sweepCloseOnExec(executionRequest);
        commitKernelProgramFileBytes(executionRequest.filesystem, fileBytes);
        const context: KernelAsyncProgramBaseContext = Object.freeze({
          filesystem: executionRequest.filesystem,
          home: executionRequest.home,
          args: ticket === undefined ? Object.freeze([...args]) : args,
          env: ticket === undefined ? Object.freeze({ ...env }) : env,
          identity: executionRequest.identity,
          signal: executionRequest.signal,
          processes: options.processes,
          wakes: options.wakes,
          ...(executionRequest.admission === undefined
            ? {}
            : { admission: executionRequest.admission }),
          ...(cpu === undefined ? {} : { cpu }),
          spawn,
        });
        return runKernelAsyncProgram(implementation.run, context, options);
      }).finally(() => cancelTicket(ticket));
    } catch (error) {
      ticket?.cancel();
      ticket?.throwCancelFailure();
      return kernelProcessSignalExitStatus(error);
    }
  });
}

function afterExecCommit<T>(run: () => T | Promise<T>): Promise<T> {
  let result: T | Promise<T>;
  try {
    result = run();
  } catch (error) {
    return Promise.reject(committedFailure(error));
  }
  return Promise.resolve(result).catch((error: unknown) => {
    throw committedFailure(error);
  });
}

function committedFailure(error: unknown): unknown {
  if (!(error instanceof KernelProgramExecAdmissionError)) return error;
  return Object.assign(new Error(error.message, { cause: error }), { code: error.code });
}

function sweepCloseOnExec(request: KernelAsyncProgramExecRequest): void {
  runSync(request.filesystem.descriptors.closeOnExecSweep());
}

function cancelTicket(ticket: KernelProgramAdmissionTicket | undefined): void {
  ticket?.cancel();
  ticket?.throwCancelFailure();
}

function beforeExecCommit<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof KernelProcessCancelledError) throw error;
    if (error instanceof KernelProgramExecAdmissionError) throw error;
    const code = errorCode(error);
    if (code === "ECANCELED" || code === "CANCELLED") {
      throw new KernelProcessCancelledError(errorMessage(error));
    }
    throw new KernelProgramExecAdmissionError(code ?? "EIO", errorMessage(error), error);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Program execution admission failed";
}

function environmentWithHome(
  home: string | undefined,
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (home === undefined || env.HOME !== undefined) return env;
  return { ...env, HOME: home };
}

function status(exitCode: number, signal = 0, coreDumped = false): KernelExitStatus {
  return Object.freeze({ exitCode, signal, coreDumped });
}

function validateStatus(value: unknown): KernelExitStatus {
  if (
    typeof value !== "object" ||
    value === null ||
    !("exitCode" in value) ||
    typeof value.exitCode !== "number" ||
    !Number.isSafeInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 0xffff_ffff ||
    !("signal" in value) ||
    typeof value.signal !== "number" ||
    !Number.isSafeInteger(value.signal) ||
    value.signal < 0 ||
    value.signal > 64 ||
    !("coreDumped" in value) ||
    typeof value.coreDumped !== "boolean"
  ) {
    throw errnoError("EIO", "Program returned an invalid exit status");
  }
  return status(value.exitCode, value.signal, value.coreDumped);
}

function kernelCodeToErrno(code: string): string {
  switch (code) {
    case "NOT_FOUND":
      return "ENOENT";
    case "UNSUPPORTED":
    case "ABI_MISMATCH":
      return "ENOTSUP";
    case "INVALID_ARGUMENT":
      return "EINVAL";
    case "INVALID_HANDLE":
      return "EBADF";
    case "PERMISSION_DENIED":
      return "EACCES";
    case "RESOURCE_LIMIT":
      return "EAGAIN";
    case "CANCELLED":
      return "ECANCELED";
    case "EXPIRED":
      return "ETIMEDOUT";
    case "ALREADY_EXISTS":
      return "EEXIST";
    case "ALREADY_WAITING":
      return "EALREADY";
    case "IO_ERROR":
      return "EIO";
    default:
      return "EIO";
  }
}

function errnoError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
