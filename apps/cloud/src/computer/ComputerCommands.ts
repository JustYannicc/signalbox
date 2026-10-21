import {
  KernelCommandExecutor,
  type KernelCommandExecutorOptions,
} from "../kernel/KernelCommandExecutor.ts";
import type { KernelCommand, KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import { KernelForwardingUnavailable } from "../kernel/KernelCommandForwarder.ts";
import type { ChildWorkerRequester } from "./ChildWorkerCapacity.ts";
import type { ComputerExecPort } from "./Computer.ts";
import type { ComputerEscalationEvidence, ComputerEscalationTable } from "./EscalationTable.ts";

export interface ComputerCommandOptions {
  readonly mode?: "legacy";
  /** The host's registered program bodies dispatch to children; the facet retains their descriptors. */
  readonly kernel: Omit<KernelCommandExecutorOptions, "forwarder">;
  readonly escalation: ComputerEscalationTable;
  readonly machine: KernelCommandForwarder;
  readonly evidence?: (
    command: KernelCommand,
    signal: AbortSignal,
  ) => Promise<ComputerEscalationEvidence>;
}

export interface AdmittedComputerCommandOptions {
  readonly mode: "admitted";
  readonly kernel: Omit<KernelCommandExecutorOptions, "forwarder" | "admitted">;
  readonly isolateKernel: Omit<KernelCommandExecutorOptions, "forwarder" | "admitted">;
}

/** Only composition code receives the isolate binding. Guest commands have no placement option. */
export function createComputerCommands(
  options: ComputerCommandOptions | AdmittedComputerCommandOptions,
): ComputerExecPort & {
  readonly isolate: ComputerExecPort;
} {
  if (options.mode === "admitted") {
    return admittedCommands(options);
  }
  const commands = new KernelCommandExecutor({
    ...options.kernel,
    forwarder: options.machine,
  });
  const local = new KernelCommandExecutor({
    ...options.kernel,
    forwarder: {
      async spawn() {
        throw new KernelForwardingUnavailable(
          "POLICY_NOT_READY",
          "Executable is not registered in Computer",
        );
      },
    },
  });
  const capture = (command: KernelCommand, signal: AbortSignal) => {
    signal.throwIfAborted();
    const captured = snapshotCommand(command);
    const canonical = options.kernel.filesystem.realpath(captured.cwd);
    if (canonical !== captured.cwd) {
      throw new KernelForwardingUnavailable("WORKSPACE_NOT_READY", "Command cwd must be canonical");
    }
    return captured;
  };
  const isolate: ComputerExecPort = Object.freeze({
    exec: (
      command: KernelCommand,
      signal: AbortSignal,
      requester: ChildWorkerRequester | undefined,
    ) => local.spawn(capture(command, signal), signal, requesterParent(options.kernel, requester)),
  });
  return Object.freeze({
    isolate,
    async exec(
      command: KernelCommand,
      signal: AbortSignal,
      requester: ChildWorkerRequester | undefined,
    ) {
      const captured = capture(command, signal);
      const evidence = await options.evidence?.(captured, signal);
      signal.throwIfAborted();
      const decision = options.escalation.decide(captured, evidence);
      return decision.kind === "machine"
        ? options.machine.spawn(captured, signal)
        : commands.spawn(captured, signal, requesterParent(options.kernel, requester));
    },
  });
}

function admittedCommands(options: AdmittedComputerCommandOptions) {
  const forwarder: KernelCommandForwarder = {
    async spawn() {
      throw new KernelForwardingUnavailable("POLICY_NOT_READY", "Command admission is required");
    },
  };
  const port = (kernel: AdmittedComputerCommandOptions["kernel"]): ComputerExecPort => {
    const executor = new KernelCommandExecutor({ ...kernel, admitted: true, forwarder });
    return Object.freeze({
      exec(
        command: KernelCommand,
        signal: AbortSignal,
        requester: ChildWorkerRequester | undefined,
      ) {
        signal.throwIfAborted();
        const captured = snapshotCommand(command);
        if (kernel.filesystem.realpath(captured.cwd) !== captured.cwd) {
          throw new KernelForwardingUnavailable(
            "WORKSPACE_NOT_READY",
            "Command cwd must be canonical",
          );
        }
        return executor.spawn(captured, signal, requesterParent(kernel, requester));
      },
    });
  };
  return Object.freeze({ ...port(options.kernel), isolate: port(options.isolateKernel) });
}

function snapshotCommand(command: KernelCommand): KernelCommand {
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
  });
}

function requesterParent(
  kernel: ComputerCommandOptions["kernel"],
  requester: ChildWorkerRequester | undefined,
) {
  if (requester === undefined) return kernel.parent;
  if (requester.processes !== kernel.host.processes) {
    throw new TypeError("Computer requester belongs to another process table");
  }
  return requester.process;
}
