import type { ChangedInode, CommitInode, ForkCommit } from "../FilePersistencePorts.ts";
import type { Inode, Stat } from "../storage.ts";
import type { createFacetFilePersistence } from "../FacetFilePersistence.ts";

export type Persistence = ReturnType<typeof createFacetFilePersistence>;

export interface TreeEntry {
  readonly inode: string;
  readonly paths: readonly string[];
  readonly stat: Stat;
  readonly symlinkTarget: string | null;
  readonly posix: { readonly mode: number; readonly uid: number; readonly gid: number } | null;
}

export interface WorkspaceState {
  readonly at: ForkCommit;
  readonly manifest: Map<string, TreeEntry>;
  readonly epoch: number;
}

export interface DirtyInode {
  readonly inode: string;
  readonly version: number;
}

export interface CheckpointAttempt {
  readonly at: ForkCommit;
  readonly manifest: string;
  readonly epoch: number;
  readonly changed: readonly ChangedInode[];
  readonly dirty: readonly DirtyInode[];
}

export interface ApplyPlan {
  readonly changed: CommitInode;
  localInode?: Inode;
  readonly sourcePaths: readonly string[];
}
