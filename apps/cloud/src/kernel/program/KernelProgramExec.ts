import { type KernelHandle, type KernelResult, type ResolvedProgram } from "../KernelAbi.ts";
import type {
  KernelAsyncProgramContext,
  KernelAsyncProgramCpu,
  KernelAsyncProgramExecRequest,
} from "../KernelAsyncProgram.ts";
import { KernelProgramExecAdmissionError } from "../KernelAsyncProgram.ts";
import type { AgentOsSpawnRequest } from "../AgentOsProcessWire.ts";
import type { KernelExitStatus, KernelProcessTable } from "../KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { enterCurrentKernelCpuUser } from "../KernelCpuExecution.ts";
import { runKernelExecution, runKernelInlineExecution } from "../process/KernelExecution.ts";
import { KernelProcessCancelledError } from "../process/KernelProcessCancellation.ts";
import { runSync } from "../wasi/internal_wasi_calls.ts";
import {
  createKernelWasiRuntime,
  runInlineJavaScript,
  type KernelProgramBinding,
} from "./KernelProgramRuntime.ts";

export interface KernelProgramExecOptions {
  readonly resolve: (path: string) => KernelResult<ResolvedProgram>;
  readonly bindingFor: (program: ResolvedProgram) => KernelProgramBinding | undefined;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
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
  return runKernelExecution(request.signal, async () => {
    if (request.signal.aborted)
      throw new KernelProcessCancelledError("Program execution cancelled");
    const resolved = beforeExecCommit(() => options.resolve(request.path));
    if (resolved.status !== "ok") {
      if (resolved.status === "error" && resolved.error.code === "CANCELLED") {
        throw new KernelProcessCancelledError(resolved.error.message);
      }
      const code =
        resolved.status === "would_block" ? "EAGAIN" : kernelCodeToErrno(resolved.error.code);
      throw new KernelProgramExecAdmissionError(
        code,
        resolved.status === "would_block"
          ? "Program resolution would block"
          : resolved.error.message,
      );
    }
    const binding = beforeExecCommit(() => options.bindingFor(resolved.value));
    if (!binding) {
      throw new KernelProgramExecAdmissionError("EIO", "Resolved program lost its implementation");
    }

    const { implementation } = binding;
    const prepared = { filesystem: request.filesystem, home: request.home };
    const spawn = beforeExecCommit(() => options.spawnFor(request));
    if (implementation.kind === "wasm") {
      // Validate every import before CLOEXEC descriptors are removed.
      const runtime = beforeExecCommit(() =>
        createKernelWasiRuntime(implementation.module, {
          ...(implementation.agentOsPreopens ? { agentOsPreopens: true } : {}),
          ...(implementation.cwdEnvironment === undefined
            ? {}
            : { cwdEnvironment: implementation.cwdEnvironment }),
          prepared,
          descriptorOwnership: "borrowed",
          args: request.args,
          env: environmentWithHome(request.home, request.env),
          asyncMode: true,
          identity: request.identity,
          signal: request.signal,
          processes: options.processes,
          wakes: options.wakes,
          spawn,
        }),
      );
      try {
        return await afterExecCommit(async () => {
          sweepCloseOnExec(request);
          const exitCode = await runtime.lifecycle.startAsync(runtime.instance);
          return status(exitCode);
        });
      } finally {
        await runtime.lifecycle.closeAsync();
      }
    }

    if (implementation.kind === "javascript") {
      return afterExecCommit(() => {
        sweepCloseOnExec(request);
        const exitCode = runKernelInlineExecution(request.signal, () =>
          runInlineJavaScript(
            implementation.runInline,
            prepared,
            request.args,
            environmentWithHome(request.home, request.env),
          ),
        );
        if (request.signal.aborted) {
          throw new KernelProcessCancelledError("Program execution cancelled");
        }
        return status(exitCode);
      });
    }

    return afterExecCommit(async () => {
      sweepCloseOnExec(request);
      const context: KernelAsyncProgramBaseContext = Object.freeze({
        filesystem: request.filesystem,
        home: request.home,
        args: Object.freeze([...request.args]),
        env: Object.freeze({ ...environmentWithHome(request.home, request.env) }),
        identity: request.identity,
        signal: request.signal,
        processes: options.processes,
        wakes: options.wakes,
        ...(cpu === undefined ? {} : { cpu }),
        spawn,
      });
      return runKernelAsyncProgram(implementation.run, context, options);
    });
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
