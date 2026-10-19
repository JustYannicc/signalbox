import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../kernel/KernelCommandForwarder.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { FileCommitReceipt } from "../kernel/FilePersistencePorts.ts";

/** Shared by command hooks, harness child processes and the exec server. */
export interface ComputerExecPort {
  readonly exec: (command: KernelCommand, signal: AbortSignal) => Promise<KernelCommandChild>;
}

export interface ComputerPort {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** One instance belongs to one thread. The session facet retains ownership of files. */
export interface Computer extends ComputerExecPort {
  readonly threadId: string;
  readonly files: KernelFileSystem;
  readonly port: (port: number, signal: AbortSignal) => Promise<ComputerPort>;
  readonly save: (signal: AbortSignal) => Promise<FileCommitReceipt>;
}

export interface ComputerOpenPort {
  readonly open: (threadId: string, signal: AbortSignal) => Promise<Computer>;
}

/** Adapt the Computer command entry point without another execution or policy path. */
export function computerCommandForwarder(computer: ComputerExecPort): KernelCommandForwarder {
  return { spawn: (command, signal) => computer.exec(command, signal) };
}
