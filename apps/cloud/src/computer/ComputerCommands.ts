import {
  KernelCommandExecutor,
  type KernelCommandExecutorOptions,
} from "../kernel/KernelCommandExecutor.ts";
import type { KernelCommand, KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import { KernelForwardingUnavailable } from "../kernel/KernelCommandForwarder.ts";
import type { ComputerExecPort } from "./Computer.ts";
import type { ComputerEscalationEvidence, ComputerEscalationTable } from "./EscalationTable.ts";

export interface ComputerCommandOptions {
  /** The host's registered program bodies dispatch to children; the facet retains their descriptors. */
  readonly kernel: Omit<KernelCommandExecutorOptions, "forwarder">;
  readonly escalation: ComputerEscalationTable;
  readonly machine: KernelCommandForwarder;
  readonly evidence?: (
    command: KernelCommand,
    signal: AbortSignal,
  ) => Promise<ComputerEscalationEvidence>;
}

/** Only composition code receives the isolate binding. Guest commands have no placement option. */
export function createComputerCommands(options: ComputerCommandOptions): ComputerExecPort & {
  readonly isolate: ComputerExecPort;
} {
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
    exec: (command: KernelCommand, signal: AbortSignal) =>
      local.spawn(capture(command, signal), signal),
  });
  return Object.freeze({
    isolate,
    async exec(command: KernelCommand, signal: AbortSignal) {
      const captured = capture(command, signal);
      const evidence = await options.evidence?.(captured, signal);
      signal.throwIfAborted();
      const decision = options.escalation.decide(captured, evidence);
      return decision.kind === "machine"
        ? options.machine.spawn(captured, signal)
        : local.spawn(captured, signal);
    },
  });
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
