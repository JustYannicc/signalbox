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
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { kernelError } from "./KernelErrno.ts";

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
      const captured = snapshotKernelCommand(command, options.filesystem);
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

export function snapshotKernelCommand(
  command: KernelCommand,
  filesystem: KernelFileSystem,
): KernelCommand {
  const { executable, argv, cwd, env: inputEnv, inheritedFds } = command;
  const text = (value: string) => typeof value === "string" && !value.includes("\0");
  if (
    !text(executable) ||
    !executable ||
    !text(cwd) ||
    !cwd.startsWith("/") ||
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every(text) ||
    !inputEnv ||
    typeof inputEnv !== "object" ||
    Array.isArray(inputEnv)
  ) {
    throw new TypeError("Invalid Computer command");
  }
  const env = Object.fromEntries(
    Object.entries(inputEnv).map(([key, value]) => {
      if (!key || !text(key) || key.includes("=") || !text(value))
        throw new TypeError("Invalid command environment");
      return [key, value];
    }),
  );
  const captured = {
    executable,
    argv: Object.freeze([...argv]),
    env: Object.freeze(env),
    ...(inheritedFds === undefined
      ? {}
      : {
          inheritedFds: Object.freeze(
            validateInheritedFds(inheritedFds).map((fd) => Object.freeze(fd)),
          ),
        }),
  };
  const canonicalCwd = filesystem.realpath(cwd);
  if (filesystem.stat(canonicalCwd).type !== "directory") throw kernelError("ENOTDIR");
  return Object.freeze({ ...captured, cwd: canonicalCwd });
}
