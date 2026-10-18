/** Signalbox's recently trashed threads and folders. Part of `WsRpcGroup`. */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { CommandId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { FolderId } from "./signalboxFolders.ts";
import { NoteId } from "./signalboxNotes.ts";

export const SIGNALBOX_TRASH_WS_METHODS = {
  list: "signalbox.trash.list",
  restore: "signalbox.trash.restore",
  empty: "signalbox.trash.empty",
  thread: "signalbox.trash.thread",
  folder: "signalbox.trash.folder",
} as const;

/** Trash keeps recoverable items for 30 days. */
export const TRASH_RETENTION_DAYS = 30;

export const SIGNALBOX_TRASH_REQUIRED_SCOPES = {
  [SIGNALBOX_TRASH_WS_METHODS.list]: AuthOrchestrationReadScope,
  [SIGNALBOX_TRASH_WS_METHODS.restore]: AuthOrchestrationOperateScope,
  [SIGNALBOX_TRASH_WS_METHODS.empty]: AuthOrchestrationOperateScope,
  [SIGNALBOX_TRASH_WS_METHODS.thread]: AuthOrchestrationOperateScope,
  [SIGNALBOX_TRASH_WS_METHODS.folder]: AuthOrchestrationOperateScope,
} as const;

export const TrashItemKind = Schema.Literals(["thread", "folder"]);
export type TrashItemKind = typeof TrashItemKind.Type;

export const TrashEntryStatus = Schema.Literals([
  "trashed",
  "restoring",
  "purging",
  "purged",
  "restored",
]);
export type TrashEntryStatus = typeof TrashEntryStatus.Type;

export const TrashEntryId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SignalboxTrashEntryId"),
);
export type TrashEntryId = typeof TrashEntryId.Type;

/** Planned scope only; no resource is physically deleted by the current service. */
export const TrashPlannedRemoval = Schema.Union([
  Schema.TaggedStruct("threadResource", {
    threadId: ThreadId,
    resource: Schema.Literals([
      "history",
      "machine-cache",
      "previews",
      "attachments",
      "automation-runs",
    ]),
  }),
  Schema.TaggedStruct("driveThreadRefs", {
    driveId: TrimmedNonEmptyString,
    threadId: ThreadId,
  }),
  Schema.TaggedStruct("folder", { folderId: FolderId }),
  Schema.TaggedStruct("note", { noteId: NoteId }),
  /** A shared drive is retained; this plan is conditional on a future ownership check. */
  Schema.TaggedStruct("drive", {
    driveId: TrimmedNonEmptyString,
    onlyIfUnshared: Schema.Literal(true),
  }),
]);
export type TrashPlannedRemoval = typeof TrashPlannedRemoval.Type;

export const TrashEntry = Schema.Struct({
  id: TrashEntryId,
  kind: TrashItemKind,
  targetId: TrimmedNonEmptyString,
  title: Schema.String,
  /** Unix epoch milliseconds. */
  deletedAt: NonNegativeInt,
  /** Unix epoch milliseconds. */
  purgeAfter: NonNegativeInt,
  status: TrashEntryStatus,
  threadIds: Schema.Array(ThreadId),
  /** Planned scope is separate from completed removals and optional for older clients. */
  plannedRemovals: Schema.optionalKey(Schema.Array(TrashPlannedRemoval)),
  removals: Schema.Array(Schema.Struct({ kind: Schema.String, id: Schema.String })),
  error: Schema.NullOr(Schema.String),
});
export type TrashEntry = typeof TrashEntry.Type;

/** The current view of recently trashed items. */
export const TrashSnapshot = Schema.Struct({
  entries: Schema.Array(TrashEntry),
  purgeEnabled: Schema.Boolean,
});
export type TrashSnapshot = typeof TrashSnapshot.Type;

export const TrashListInput = Schema.Struct({});
export const TrashRestoreInput = Schema.Struct({ id: TrashEntryId });
export const TrashEmptyInput = Schema.Struct({
  ids: Schema.optionalKey(Schema.Array(TrashEntryId)),
});
export const TrashThreadInput = Schema.Struct({
  threadId: ThreadId,
  commandId: Schema.optionalKey(CommandId),
});
export const TrashFolderInput = Schema.Struct({ folderId: FolderId });

export class SignalboxTrashUnavailableError extends Schema.TaggedError<SignalboxTrashUnavailableError>()(
  "SignalboxTrashUnavailableError",
  {},
) {
  override get message(): string {
    return "Trash is only available in Signalbox Cloud.";
  }
}

/** The requested trash operation was refused or failed. */
export class SignalboxTrashError extends Schema.TaggedError<SignalboxTrashError>()(
  "SignalboxTrashError",
  { message: Schema.String },
) {}

const TrashErrors = Schema.Union([
  SignalboxTrashUnavailableError,
  SignalboxTrashError,
  EnvironmentAuthorizationError,
]);

const change = <const Tag extends string, P extends Schema.Top>(tag: Tag, payload: P) =>
  Rpc.make(tag, { payload, success: TrashSnapshot, error: TrashErrors });

/** Every entry and its current lifecycle status. */
export const SIGNALBOX_TRASH_RPCS = [
  Rpc.make(SIGNALBOX_TRASH_WS_METHODS.list, {
    payload: TrashListInput,
    success: TrashSnapshot,
    error: TrashErrors,
  }),
  change(SIGNALBOX_TRASH_WS_METHODS.restore, TrashRestoreInput),
  change(SIGNALBOX_TRASH_WS_METHODS.empty, TrashEmptyInput),
  change(SIGNALBOX_TRASH_WS_METHODS.thread, TrashThreadInput),
  change(SIGNALBOX_TRASH_WS_METHODS.folder, TrashFolderInput),
] as const;
