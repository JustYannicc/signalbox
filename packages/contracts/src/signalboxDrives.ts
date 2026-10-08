/**
 * Signalbox drives. Part of `WsRpcGroup`.
 *
 * A drive holds files with their history, like Google Drive's. Each person
 * has a My Drive in every context, private until they share something from
 * it. Work organizations have shared drives with members. Sharing a folder
 * from My Drive splits it into its own drive, with its history, so the
 * people it's shared with see only that folder. Every drive is a project in
 * the shell, listed under its context; threads started in it work in it. A
 * thread's own visibility doesn't depend on its drive. See #125.
 *
 * Roles follow Google Drive: Manager, Content manager, Contributor, Commenter
 * and Viewer on shared drives; Owner, Editor, Commenter and Viewer on a My
 * Drive and the folders shared from it.
 *
 * Only Signalbox Cloud serves these (`capabilities.signalboxCloud`). A
 * self-hosted server answers `SignalboxDrivesUnavailableError`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SignalboxContextId } from "./signalboxContexts.ts";

export const SIGNALBOX_DRIVES_WS_METHODS = {
  subscribe: "signalbox.drives.subscribe",
  create: "signalbox.drives.create",
  members: "signalbox.drives.members",
  share: "signalbox.drives.share",
  unshare: "signalbox.drives.unshare",
  shareFolder: "signalbox.drives.shareFolder",
} as const;

/** Seeing drives and who's in them is reading; the rest changes who can see what. */
export const SIGNALBOX_DRIVES_REQUIRED_SCOPES = {
  [SIGNALBOX_DRIVES_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_DRIVES_WS_METHODS.members]: AuthOrchestrationReadScope,
  [SIGNALBOX_DRIVES_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [SIGNALBOX_DRIVES_WS_METHODS.share]: AuthOrchestrationOperateScope,
  [SIGNALBOX_DRIVES_WS_METHODS.unshare]: AuthOrchestrationOperateScope,
  [SIGNALBOX_DRIVES_WS_METHODS.shareFolder]: AuthOrchestrationOperateScope,
} as const;

export const SignalboxDriveId = TrimmedNonEmptyString.pipe(Schema.brand("SignalboxDriveId"));
export type SignalboxDriveId = typeof SignalboxDriveId.Type;

/** `my`: a person's My Drive. `shared`: an organization's shared drive. `folder`: a folder shared from a My Drive. */
export const SignalboxDriveKind = Schema.Literals(["my", "shared", "folder"]);
export type SignalboxDriveKind = typeof SignalboxDriveKind.Type;

/** Roles on a shared drive, most access first. */
export const SharedDriveRole = Schema.Literals([
  "manager",
  "content_manager",
  "contributor",
  "commenter",
  "viewer",
]);
export type SharedDriveRole = typeof SharedDriveRole.Type;

/** Roles on a My Drive and the folders shared from it, most access first. */
export const DriveItemRole = Schema.Literals(["owner", "editor", "commenter", "viewer"]);
export type DriveItemRole = typeof DriveItemRole.Type;

export const SignalboxDriveRole = Schema.Union([SharedDriveRole, DriveItemRole]);
export type SignalboxDriveRole = typeof SignalboxDriveRole.Type;

/** Whether `role` decides who else is in the drive. */
export const canManageDrive = (role: SignalboxDriveRole | null) =>
  role === "manager" || role === "owner";

const NO_ROLES: ReadonlyArray<SignalboxDriveRole> = [];
/** A folder has exactly one owner, the person whose My Drive it came from. */
const FOLDER_ROLES: ReadonlyArray<SignalboxDriveRole> = ["editor", "commenter", "viewer"];

/** The roles a drive of `kind` can grant. A My Drive itself is never shared, only its folders. */
export const grantableDriveRoles = (
  kind: SignalboxDriveKind,
): ReadonlyArray<SignalboxDriveRole> => {
  switch (kind) {
    case "shared":
      return SharedDriveRole.literals;
    case "folder":
      return FOLDER_ROLES;
    case "my":
      return NO_ROLES;
  }
};

/** A drive the user can open. */
export const SignalboxDrive = Schema.Struct({
  id: SignalboxDriveId,
  /** The drive's project in the shell. Threads started in it work in the drive. */
  projectId: ProjectId,
  /** The context it's listed under, and that threads in it act as. */
  contextId: SignalboxContextId,
  kind: SignalboxDriveKind,
  name: Schema.String,
  role: SignalboxDriveRole,
  /** Who shared it with the user, when it's in their Shared with me. */
  sharedBy: Schema.NullOr(Schema.String),
});
export type SignalboxDrive = typeof SignalboxDrive.Type;

/** Every drive the user can open, across their contexts. */
export const SignalboxDrivesSnapshot = Schema.Struct({
  drives: Schema.Array(SignalboxDrive),
});
export type SignalboxDrivesSnapshot = typeof SignalboxDrivesSnapshot.Type;

export const SignalboxDriveMember = Schema.Struct({
  userId: TrimmedNonEmptyString,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: SignalboxDriveRole,
});
export type SignalboxDriveMember = typeof SignalboxDriveMember.Type;

export const SignalboxDriveCreateInput = Schema.Struct({
  /** A work organization: shared drives belong to one. */
  contextId: SignalboxContextId,
  name: TrimmedNonEmptyString,
});
export type SignalboxDriveCreateInput = typeof SignalboxDriveCreateInput.Type;

export const SignalboxDriveShareInput = Schema.Struct({
  driveId: SignalboxDriveId,
  /** The person's Signalbox sign-in email. */
  email: TrimmedNonEmptyString,
  role: SignalboxDriveRole,
});
export type SignalboxDriveShareInput = typeof SignalboxDriveShareInput.Type;

export const SignalboxDriveUnshareInput = Schema.Struct({
  driveId: SignalboxDriveId,
  userId: TrimmedNonEmptyString,
});
export type SignalboxDriveUnshareInput = typeof SignalboxDriveUnshareInput.Type;

export const SignalboxDriveShareFolderInput = Schema.Struct({
  /** A My Drive the user owns. */
  driveId: SignalboxDriveId,
  /** The folder, relative to the drive's root. */
  path: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  role: DriveItemRole,
});
export type SignalboxDriveShareFolderInput = typeof SignalboxDriveShareFolderInput.Type;

export class SignalboxDrivesUnavailableError extends Schema.TaggedError<SignalboxDrivesUnavailableError>()(
  "SignalboxDrivesUnavailableError",
  {},
) {
  override get message(): string {
    return "Drives are only available in Signalbox Cloud.";
  }
}

/** The drive change was refused or failed; `message` says why, for the user. */
export class SignalboxDriveError extends Schema.TaggedError<SignalboxDriveError>()(
  "SignalboxDriveError",
  { message: Schema.String },
) {}

const DriveErrors = Schema.Union([
  SignalboxDrivesUnavailableError,
  SignalboxDriveError,
  EnvironmentAuthorizationError,
]);

/** The user's drives now and after every change. */
const SubscribeRpc = Rpc.make(SIGNALBOX_DRIVES_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignalboxDrivesSnapshot,
  error: DriveErrors,
  stream: true,
});

/** A new shared drive in a work organization, with the user as its manager. */
const CreateRpc = Rpc.make(SIGNALBOX_DRIVES_WS_METHODS.create, {
  payload: SignalboxDriveCreateInput,
  success: SignalboxDrive,
  error: DriveErrors,
});

const MembersRpc = Rpc.make(SIGNALBOX_DRIVES_WS_METHODS.members, {
  payload: Schema.Struct({ driveId: SignalboxDriveId }),
  success: Schema.Struct({ members: Schema.Array(SignalboxDriveMember) }),
  error: DriveErrors,
});

/** Adds someone to a drive, or changes their role. */
const ShareRpc = Rpc.make(SIGNALBOX_DRIVES_WS_METHODS.share, {
  payload: SignalboxDriveShareInput,
  success: SignalboxDriveMember,
  error: DriveErrors,
});

/** Removes someone from a drive. Their access ends everywhere at once. */
const UnshareRpc = Rpc.make(SIGNALBOX_DRIVES_WS_METHODS.unshare, {
  payload: SignalboxDriveUnshareInput,
  success: Schema.Void,
  error: DriveErrors,
});

/**
 * Shares a folder of the user's My Drive. The first share splits it into its
 * own drive, with its history, and leaves a shortcut at the same path.
 */
const ShareFolderRpc = Rpc.make(SIGNALBOX_DRIVES_WS_METHODS.shareFolder, {
  payload: SignalboxDriveShareFolderInput,
  success: SignalboxDrive,
  error: DriveErrors,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_DRIVES_RPCS = [
  SubscribeRpc,
  CreateRpc,
  MembersRpc,
  ShareRpc,
  UnshareRpc,
  ShareFolderRpc,
] as const;
