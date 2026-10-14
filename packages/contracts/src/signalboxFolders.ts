/**
 * Signalbox folders. Part of `WsRpcGroup`.
 *
 * A user's tree: their top level, and folders below it that nest freely, like
 * folders on a computer. A folder holds threads, a pool, instructions and,
 * optionally, its own files: a drive, shown as one source. Every thread has a
 * home folder (or the top level) and runs on its home's chain, the home and
 * every level above it: the nearest pool on the chain, and every level's
 * instructions, top level first. Moving a thread changes both from its next
 * turn; the files it works in stay the ones it started in. See #225 and #227.
 *
 * Folders replace sections and projects in Signalbox Cloud, which still
 * serves `sections.*` for older clients as a view of its folders. Only
 * Signalbox Cloud serves these (`capabilities.folders`). A self-hosted server
 * answers `SignalboxFoldersUnavailableError` and keeps its sections.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AccountPoolId } from "./accountHub.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SignalboxContextId } from "./signalboxContexts.ts";

export const SIGNALBOX_FOLDERS_WS_METHODS = {
  subscribe: "signalbox.folders.subscribe",
  create: "signalbox.folders.create",
  update: "signalbox.folders.update",
  move: "signalbox.folders.move",
  delete: "signalbox.folders.delete",
  moveThread: "signalbox.folders.moveThread",
  setInstructions: "signalbox.folders.setInstructions",
} as const;

/** Reading the tree is reading the sidebar; the rest changes what threads run on. */
export const SIGNALBOX_FOLDERS_REQUIRED_SCOPES = {
  [SIGNALBOX_FOLDERS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.update]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.move]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.delete]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.moveThread]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.setInstructions]: AuthOrchestrationOperateScope,
} as const;

export const FolderId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SignalboxFolderId"),
);
export type FolderId = typeof FolderId.Type;

const FolderName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** What agents can load beside a drive's own `AGENTS.md`: the Runner's limit. */
const FOLDER_INSTRUCTIONS_MAX_LENGTH = 32 * 1024;
const Instructions = Schema.String.check(Schema.isMaxLength(FOLDER_INSTRUCTIONS_MAX_LENGTH));

/** A level of the tree: the top level, or a folder. */
export const FolderLevel = Schema.Union([
  Schema.TaggedStruct("top", {}),
  Schema.TaggedStruct("folder", { folderId: FolderId }),
]);
export type FolderLevel = typeof FolderLevel.Type;

/** The pool a level runs on, and the level it's placed at. */
export const FolderResolvedPool = Schema.Struct({ poolId: AccountPoolId, from: FolderLevel });
export type FolderResolvedPool = typeof FolderResolvedPool.Type;

export const Folder = Schema.Struct({
  id: FolderId,
  /** Its own name, or its files' when it was never renamed. */
  name: FolderName,
  parentId: Schema.NullOr(FolderId),
  position: NonNegativeInt,
  /** Whose tree it's in: Personal, or a work organization. A folder never leaves it. */
  ownerId: SignalboxContextId,
  /**
   * Its files, as the project threads started here work in. Absent: none of
   * its own, so new threads here work in the owner's top-level files.
   */
  files: Schema.optionalKey(Schema.Struct({ projectId: ProjectId })),
  /** The pool placed here. Absent inherits from above. */
  poolId: Schema.optionalKey(AccountPoolId),
  /** Its `AGENTS.md`: what agents in it and below follow, after the levels above. */
  instructions: Schema.optionalKey(Instructions),
});
export type Folder = typeof Folder.Type;

/** A thread filed somewhere other than its project's home. Null: the top level. */
export const FolderThreadHome = Schema.Struct({
  threadId: ThreadId,
  folderId: Schema.NullOr(FolderId),
});
export type FolderThreadHome = typeof FolderThreadHome.Type;

/** Where a project's threads live unless filed elsewhere: the folder it's the files of, or the top level. */
export const FolderProjectHome = Schema.Struct({
  projectId: ProjectId,
  folderId: Schema.NullOr(FolderId),
});
export type FolderProjectHome = typeof FolderProjectHome.Type;

/**
 * The user's tree. A thread's home is its `threadHomes` entry, else its
 * project's `projectHomes` entry, else the top level.
 */
export const SignalboxFoldersSnapshot = Schema.Struct({
  /** Increases on every committed change. */
  revision: NonNegativeInt,
  top: Schema.Struct({ instructions: Schema.optionalKey(Instructions) }),
  folders: Schema.Array(Folder),
  threadHomes: Schema.Array(FolderThreadHome),
  projectHomes: Schema.Array(FolderProjectHome),
  /**
   * What every level runs on: the nearest pool on its chain. One pool
   * supplies every harness. Null: none on the chain, so its threads need one.
   */
  pools: Schema.Struct({
    top: Schema.NullOr(FolderResolvedPool),
    folders: Schema.Array(
      Schema.Struct({ folderId: FolderId, pool: Schema.NullOr(FolderResolvedPool) }),
    ),
  }),
});
export type SignalboxFoldersSnapshot = typeof SignalboxFoldersSnapshot.Type;

export const FolderCreateInput = Schema.Struct({
  name: FolderName,
  parentId: Schema.NullOr(FolderId),
  beforeId: Schema.optionalKey(FolderId),
  /** Whose tree a top-level folder goes in; Personal when absent. Inside a folder, its parent's. */
  ownerId: Schema.optionalKey(SignalboxContextId),
});
export type FolderCreateInput = typeof FolderCreateInput.Type;

/** Changes the given fields. */
export const FolderUpdateInput = Schema.Struct({
  id: FolderId,
  name: Schema.optionalKey(FolderName),
  /** Null: inherit from above. */
  poolId: Schema.optionalKey(Schema.NullOr(AccountPoolId)),
  /**
   * A drive's project to use as this folder's files, taken from any folder
   * that had it; null: no files of its own. The drive itself never changes.
   */
  files: Schema.optionalKey(Schema.NullOr(ProjectId)),
});
export type FolderUpdateInput = typeof FolderUpdateInput.Type;

export const FolderMoveInput = Schema.Struct({
  id: FolderId,
  parentId: Schema.NullOr(FolderId),
  beforeId: Schema.optionalKey(FolderId),
});
export type FolderMoveInput = typeof FolderMoveInput.Type;

/** Its folders and threads move up to its parent. No thread or file is deleted. */
export const FolderDeleteInput = Schema.Struct({ id: FolderId });
export type FolderDeleteInput = typeof FolderDeleteInput.Type;

/**
 * Files a thread in a folder of its owner's tree, or the top level (null). A
 * thread not created yet can be filed first, so its first turn already runs
 * on its home's chain.
 */
export const FolderMoveThreadInput = Schema.Struct({
  threadId: ThreadId,
  folderId: Schema.NullOr(FolderId),
});
export type FolderMoveThreadInput = typeof FolderMoveThreadInput.Type;

/** Replaces a level's `AGENTS.md`; empty removes it. */
export const FolderSetInstructionsInput = Schema.Struct({
  level: FolderLevel,
  instructions: Instructions,
});
export type FolderSetInstructionsInput = typeof FolderSetInstructionsInput.Type;

export class SignalboxFoldersUnavailableError extends Schema.TaggedError<SignalboxFoldersUnavailableError>()(
  "SignalboxFoldersUnavailableError",
  {},
) {
  override get message(): string {
    return "Folders are only available in Signalbox Cloud.";
  }
}

/** The change was refused or failed; `message` says why, for the user. */
export class SignalboxFolderError extends Schema.TaggedError<SignalboxFolderError>()(
  "SignalboxFolderError",
  { message: Schema.String },
) {}

const FolderErrors = Schema.Union([
  SignalboxFoldersUnavailableError,
  SignalboxFolderError,
  EnvironmentAuthorizationError,
]);

const change = <const Tag extends string, P extends Schema.Top>(tag: Tag, payload: P) =>
  Rpc.make(tag, { payload, success: SignalboxFoldersSnapshot, error: FolderErrors });

/** The tree now and after every change. */
const SubscribeRpc = Rpc.make(SIGNALBOX_FOLDERS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignalboxFoldersSnapshot,
  error: FolderErrors,
  stream: true,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_FOLDERS_RPCS = [
  SubscribeRpc,
  change(SIGNALBOX_FOLDERS_WS_METHODS.create, FolderCreateInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.update, FolderUpdateInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.move, FolderMoveInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.delete, FolderDeleteInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.moveThread, FolderMoveThreadInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.setInstructions, FolderSetInstructionsInput),
] as const;
