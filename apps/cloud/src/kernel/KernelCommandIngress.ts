import * as Schema from "effect/Schema";
import {
  KernelCommandExecutor,
  type KernelCommandExecutorOptions,
} from "./KernelCommandExecutor.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import { InheritedFd } from "./KernelInheritedFds.ts";
import { KernelForwardingUnavailable, type KernelCommand } from "./KernelCommandForwarder.ts";
import type { KernelHandle } from "./KernelAbi.ts";
import type { KernelProcessTable } from "./KernelProcessTable.ts";

export interface KernelCommandRequester {
  readonly processes: Pick<KernelProcessTable, "admissionOwner" | "setAdmissionOwner"> &
    Partial<Pick<KernelProcessTable, "info" | "admissionScope">>;
  readonly process: KernelHandle<"process"> | undefined;
  readonly parentPid?: number;
}

export interface KernelCommandExecutionPort {
  readonly exec: (
    command: KernelCommand,
    signal: AbortSignal,
    requester: KernelCommandRequester | undefined,
  ) => ReturnType<KernelCommandExecutor["spawn"]>;
}

const decodeInheritedFds = Schema.decodeUnknownSync(Schema.Array(InheritedFd));
function validateInheritedFds(input: unknown) {
  try {
    return decodeInheritedFds(input);
  } catch {
    throw new KernelProgramExecAdmissionError("ENOTSUP", "Unsupported inherited file descriptors");
  }
}

export function createKernelCommandIngress(
  options: Omit<KernelCommandExecutorOptions, "forwarder" | "admitted">,
): KernelCommandExecutionPort {
  const executor = new KernelCommandExecutor({
    ...options,
    admitted: true,
    forwarder: {
      async spawn() {
        throw new KernelForwardingUnavailable("POLICY_NOT_READY", "Command admission is required");
      },
    },
  });
  return {
    exec(command, signal, requester) {
      signal.throwIfAborted();
      const captured = snapshotKernelCommand(command);
      if (options.filesystem.realpath(captured.cwd) !== captured.cwd)
        throw new KernelForwardingUnavailable(
          "WORKSPACE_NOT_READY",
          "Command cwd must be canonical",
        );
      if (requester !== undefined && requester.processes !== options.host.processes)
        throw new TypeError("Computer requester belongs to another process table");
      return executor.spawn(
        captured,
        signal,
        requester === undefined ? options.parent : requester.process,
      );
    },
  };
}

export function snapshotKernelCommand(command: KernelCommand): KernelCommand {
  const text = (value: string) => typeof value === "string" && !value.includes("\0");
  if (
    !text(command.executable) ||
    !command.executable ||
    !text(command.cwd) ||
    !command.cwd.startsWith("/") ||
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    !command.argv.every(text) ||
    !command.env ||
    typeof command.env !== "object" ||
    Array.isArray(command.env)
  ) {
    throw new TypeError("Invalid Computer command");
  }
  const env = Object.fromEntries(
    Object.entries(command.env).map(([key, value]) => {
      if (!key || !text(key) || key.includes("=") || !text(value))
        throw new TypeError("Invalid command environment");
      return [key, value];
    }),
  );
  return Object.freeze({
    executable: command.executable,
    argv: Object.freeze([...command.argv]),
    cwd: command.cwd,
    env: Object.freeze(env),
    ...(command.inheritedFds === undefined
      ? {}
      : {
          inheritedFds: Object.freeze(
            validateInheritedFds(command.inheritedFds).map((fd) => Object.freeze(fd)),
          ),
        }),
  });
}
