import type { CommitInode, FileHydrationPort, ForkCommit } from "../kernel/FilePersistencePorts.ts";
import type {
  ThreadExecWorkspace,
  ThreadExecPolicy,
  ThreadExecForwarder,
} from "../thread/ThreadExecForwarder.ts";
import type { MachineHandle, MachineOwnershipAttestation } from "./Machine.ts";
import type { MachineFilesPort } from "./MachineFilesPort.ts";

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
  /**
   * Reattach to the same VM mount after a facet restart. Missing support must leave the
   * journal pending; it is never safe to rebuild a workspace from an unverified machine.
   */
  readonly resume?: (input: {
    readonly operationId: string;
    readonly machine: MachineHandle;
    readonly before: ForkCommit;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly mount: MachineWorkspaceMount;
    readonly ownership: MachineWorkspaceOwnershipAttestation;
  }>;
  /** Apply through hydration into the same live filesystem, preserving open inode identities. */
  readonly apply: (input: {
    readonly before: ForkCommit;
    readonly after: ForkCommit;
    readonly changedInodes: readonly CommitInode[];
    readonly hydration: FileHydrationPort;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export interface MachineWorkspaceOwnershipAttestation extends MachineOwnershipAttestation {
  readonly before: ForkCommit;
}

export interface MachineProcessClosureAttestation extends MachineOwnershipAttestation {
  readonly closed: true;
}

export interface MachineRuntimeSettlement {
  /** The runtime's durable binding to this command's exact machine generation. */
  readonly owner: MachineOwnershipAttestation;
  /** Must return only after this operation can no longer write to the VM workspace. */
  readonly quiesce: (signal: AbortSignal) => Promise<MachineProcessClosureAttestation>;
  readonly dispose: () => Promise<void>;
}

export interface MachineCommandRuntimeBinding extends MachineRuntimeSettlement {
  readonly spawn: ThreadExecForwarder["spawn"];
  readonly machineFiles: MachineFilesPort;
}

export interface MachineCommandRuntime {
  /** Bind the VM's command-only Runner socket and lease, after accepting its fresh hello. */
  readonly attach: (input: {
    readonly operationId: string;
    readonly machine: MachineHandle;
    readonly workspace: ThreadExecWorkspace;
    readonly policy: ThreadExecPolicy;
    readonly signal: AbortSignal;
  }) => Promise<MachineCommandRuntimeBinding>;
  /** Rebind an interrupted operation without exposing a command-spawn path. */
  readonly rebind?: (input: {
    readonly operationId: string;
    readonly machine: MachineHandle;
    readonly signal: AbortSignal;
  }) => Promise<MachineRuntimeSettlement>;
}
