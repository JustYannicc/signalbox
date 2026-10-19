import type { KernelHandle, KernelResult } from "./KernelAbi.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type {
  KernelExitStatus,
  KernelProcessIdentity,
  KernelProcessTable,
} from "./KernelProcessTable.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

export interface KernelAsyncProgramExecRequest {
  readonly filesystem: KernelFileSystem;
  readonly identity: KernelProcessIdentity;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly path: string;
  readonly home?: string;
}

export interface KernelAsyncProgramCpu {
  /** Selects one process identity without keeping a CPU scope open during waits. */
  run<T>(run: () => T): T;
  /** Runs one synchronous user-code slice; async waits stay outside the scope. */
  runUser<T>(run: () => T): T;
  forProcess(pid: number): KernelAsyncProgramCpu;
  stop(): void;
}

export interface KernelAsyncProgramContext {
  readonly filesystem: KernelFileSystem;
  readonly home: string | undefined;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly identity: KernelProcessIdentity;
  readonly signal: AbortSignal;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly cpu?: KernelAsyncProgramCpu;
  readonly spawn: (request: AgentOsSpawnRequest) => Promise<KernelResult<KernelHandle<"process">>>;
  readonly exec: (request: KernelAsyncProgramExecRequest) => Promise<KernelExitStatus>;
}

export interface KernelAsyncProgram {
  run(context: KernelAsyncProgramContext): Promise<KernelExitStatus>;
}

/** An exec failure that occurred before the replacement image was committed. */
export class KernelProgramExecAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "KernelProgramExecAdmissionError";
    this.code = code;
  }
}

export type { KernelExitStatus };
