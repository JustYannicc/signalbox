import type { PosixMetadata } from "../../src/kernel/PosixStorage.ts";
import type { FileHydrationPort } from "../../src/kernel/FilePersistencePorts.ts";
import type { Inode, Stat } from "../../src/kernel/storage.ts";
import type { BoxdProofMachineIdentity, BoxdProofMachineIdentityObservation } from "./Identity.ts";

/** PROOF ONLY: one /workspace/out.bin file; this makes no production Drive or Artifacts claim. */
export const BOXD_PROOF_WORKSPACE_LABEL = "proof-only: one tracked /workspace/out.bin";

export const BOXD_PROOF_WORKSPACE_ROOT = "/workspace";
export const BOXD_PROOF_TRACKED_PATH = "/out.bin";
export const BOXD_PROOF_TRACKED_SCAN_PATH = BOXD_PROOF_TRACKED_PATH.slice(1);
export const BOXD_PROOF_TRACKED_VM_PATH = `${BOXD_PROOF_WORKSPACE_ROOT}${BOXD_PROOF_TRACKED_PATH}`;
export const BOXD_PROOF_MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface BoxdProofVmPort {
  /** The parent prepends its SDK-owned Python command; these args never run user commands. */
  readonly exec: (
    machineId: string,
    argv: readonly string[],
    cwd: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  /** Raw SDK transfer; stdout is never used to carry file bytes. */
  readonly upload: (
    machineId: string,
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly download: (machineId: string, path: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Reads real boxd machine identity before the command Runner's hostname setup. */
  readonly measureIdentity: (
    machineId: string,
    signal: AbortSignal,
  ) => Promise<BoxdProofMachineIdentity>;
}

export interface BoxdProofTrackedFile {
  /** KernelRevisionWorkspace path relative to its mount root; this proof supports only `/out.bin`. */
  readonly path: string;
  /** Original kernel inode. Native VM inode numbers never cross this boundary. */
  readonly inode: Inode;
  readonly stat: Readonly<Stat>;
  readonly posix?: Readonly<PosixMetadata> | null;
}

export interface BoxdProofWorkspaceOptions {
  readonly vm: BoxdProofVmPort;
  readonly trackedFiles: readonly BoxdProofTrackedFile[];
  readonly onMachineIdentity?: (observation: BoxdProofMachineIdentityObservation) => Promise<void>;
}

/** The resume factory needs durable before-revision reads, but never writes them into the VM. */
export interface BoxdProofWorkspaceResumeOptions extends BoxdProofWorkspaceOptions {
  readonly hydration: FileHydrationPort;
}

export class BoxdProofWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoxdProofWorkspaceError";
  }
}

export interface BoxdProofNativeFileMetadata {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: string;
  readonly nlink: string;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export interface BoxdProofNativeScan {
  readonly entries: readonly BoxdProofNativeFileMetadata[];
}

export interface BoxdProofNativeWorkspaceChange {
  readonly metadata: BoxdProofNativeFileMetadata;
  readonly bytes: Uint8Array;
}

/** Metadata that survives rebuilding the owner; ctime and unspecified ownership cannot. */
export interface BoxdProofNativeResumeBaseline {
  readonly size: string;
  readonly nlink: string;
  readonly mtimeNs: string;
  readonly mode: number;
  readonly uid: number | null;
  readonly gid: number | null;
}

export interface BoxdProofNativeWorkspace {
  readonly validateCwd: (requested: string, signal: AbortSignal) => Promise<void>;
  readonly readChanges: (
    signal: AbortSignal,
  ) => Promise<BoxdProofNativeWorkspaceChange | undefined>;
}
