import type { CommitInode, FileHydrationPort, ForkCommit } from "../kernel/FilePersistencePorts.ts";
import type {
  ThreadExecWorkspace,
  ThreadExecPolicy,
  ThreadExecForwarder,
} from "../thread/ThreadExecForwarder.ts";
import type { MachineHandle } from "./Machine.ts";

export interface MachineWorkspaceMount extends ThreadExecWorkspace {
  /** Read immutable post-command bytes until the FileCommitPort call settles. */
  readonly changes: (signal: AbortSignal) => Promise<readonly CommitInode[]>;
}

export interface MachineWorkspace {
  /** The owning facet commits through its FileCommitPort before a VM can execute. */
  readonly checkpoint: (operationId: string, signal: AbortSignal) => Promise<ForkCommit>;
  readonly prepare: (
    machine: MachineHandle,
    at: ForkCommit,
    hydration: FileHydrationPort,
    signal: AbortSignal,
  ) => Promise<MachineWorkspaceMount>;
  /** Apply through hydration into the same live filesystem, preserving open inode identities. */
  readonly apply: (input: {
    readonly before: ForkCommit;
    readonly after: ForkCommit;
    readonly changedInodes: readonly CommitInode[];
    readonly hydration: FileHydrationPort;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export interface MachineCommandRuntime {
  /** Bind the VM's command-only Runner socket and lease, after accepting its fresh hello. */
  readonly attach: (input: {
    readonly machine: MachineHandle;
    readonly workspace: ThreadExecWorkspace;
    readonly policy: ThreadExecPolicy;
    readonly signal: AbortSignal;
  }) => Promise<Pick<ThreadExecForwarder, "spawn" | "dispose">>;
}
