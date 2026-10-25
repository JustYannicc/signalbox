export interface ProcessIdentity {
  readonly platform: NodeJS.Platform;
  readonly bootId: string;
  readonly startTime: string;
}

export type ProcessInspection =
  | {
      readonly state: "running";
      readonly identity: ProcessIdentity;
      readonly cwd: string;
    }
  | { readonly state: "missing" }
  | {
      readonly state: "unknown";
      readonly reason: "unsupported-platform" | "inaccessible" | "invalid-identity";
    };

export interface ProcessMetrics {
  readonly cpuPercent?: number;
  readonly rssBytes?: number;
  readonly listeningPorts?: ReadonlyArray<number>;
}

export interface ProcessOps {
  identify(pid: number): Promise<ProcessIdentity | undefined>;
  inspect(pid: number): Promise<ProcessInspection>;
  metrics(pids: ReadonlyArray<number>): Promise<ReadonlyMap<number, ProcessMetrics>>;
  sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  wait(milliseconds: number): Promise<void>;
}

export interface RegisterProcessInput {
  readonly worktreePath: string;
  readonly pid: number;
  readonly sessionId?: string;
  readonly ports?: ReadonlyArray<number>;
  readonly label?: string;
  readonly ownerPid?: number;
}

export interface AgentProcessRecord extends RegisterProcessInput {
  readonly version: 1;
  readonly id: string;
  readonly worktreePath: string;
  readonly identity: ProcessIdentity;
  readonly ownerIdentity?: ProcessIdentity;
  readonly createdAt: string;
}

export interface RegistryReadOptions {
  readonly worktreePath?: string;
  readonly commonDir?: string;
}

export type ProcessStatusState = "running" | "exited" | "reused" | "cwd-mismatch" | "unknown";

export interface AgentProcessStatus {
  readonly process: AgentProcessRecord;
  readonly state: ProcessStatusState;
  readonly cwd?: string;
  readonly reason?: string;
  readonly cpuPercent?: number;
  readonly rssBytes?: number;
  readonly listeningPorts?: ReadonlyArray<number>;
}

export interface ProcessSurvivor {
  readonly pid: number;
  readonly sessionId?: string;
  readonly ownerPid?: number;
  readonly reason: string;
}

export interface StopOptions {
  readonly sessionId?: string;
  readonly ownerPid?: number;
  readonly graceMs?: number;
  readonly print?: (text: string) => void | Promise<void>;
}

export interface StopResult {
  readonly candidates: ReadonlyArray<number>;
  readonly stopped: ReadonlyArray<number>;
  readonly removed: ReadonlyArray<number>;
  readonly survivors: ReadonlyArray<ProcessSurvivor>;
}

export interface ReapOptions {
  readonly commonDir?: string;
  readonly finishedSessionIds?: ReadonlyArray<string>;
  readonly isSessionEnded?: (sessionId: string, worktreePath: string) => boolean | Promise<boolean>;
  readonly graceMs?: number;
  readonly print?: (text: string) => void | Promise<void>;
}

export interface ReapResult extends StopResult {
  readonly considered: number;
}

export interface WorktreeClosureLease {
  readonly commonDir: string;
  readonly release: () => Promise<void>;
}

export interface AgentProcessRegistryOptions {
  readonly commonDirResolver?: (worktreePath: string) => string;
  readonly processOps?: ProcessOps;
}

export interface AgentProcessRegistry {
  registerProcess(input: RegisterProcessInput): Promise<() => Promise<void>>;
  closeWorktree(worktreePath: string): Promise<WorktreeClosureLease>;
  snapshot(options?: RegistryReadOptions): Promise<Array<AgentProcessRecord>>;
  status(options?: RegistryReadOptions): Promise<Array<AgentProcessStatus>>;
  stop(worktreePath: string, options?: StopOptions): Promise<StopResult>;
  reap(options?: ReapOptions): Promise<ReapResult>;
}
