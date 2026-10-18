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

export interface KernelAsyncProgramContext {
  readonly filesystem: KernelFileSystem;
  readonly home: string | undefined;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly identity: KernelProcessIdentity;
  readonly signal: AbortSignal;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
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
