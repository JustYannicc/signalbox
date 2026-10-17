/**
 * Signalbox folders. Part of `WsRpcGroup`.
 *
 * A user's tree: their top level, and folders below it that nest freely, like
 * folders on a computer. A folder holds threads, a pool, instructions and,
 * optionally, its own files: a drive, shown as one source. Every thread has a
 * home folder (or the top level) and runs on its home's chain, the home and
 * every level above it: the nearest pool on the chain, and every level's
 * instructions and secrets, top level first. Moving a thread changes them
 * from its next turn; the files it works in stay the ones it started in. See
 * #225, #227 and #395.
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
import { type SignalboxContext, SignalboxContextId } from "./signalboxContexts.ts";

export const SIGNALBOX_FOLDERS_WS_METHODS = {
  subscribe: "signalbox.folders.subscribe",
  create: "signalbox.folders.create",
  update: "signalbox.folders.update",
  move: "signalbox.folders.move",
  delete: "signalbox.folders.delete",
  moveThread: "signalbox.folders.moveThread",
  setInstructions: "signalbox.folders.setInstructions",
  setPhase: "signalbox.folders.setPhase",
  setSecrets: "signalbox.folders.setSecrets",
  setOnePassword: "signalbox.folders.setOnePassword",
  revokeSecretSend: "signalbox.folders.revokeSecretSend",
  setGitHubLend: "signalbox.folders.setGitHubLend",
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
  [SIGNALBOX_FOLDERS_WS_METHODS.setPhase]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.setSecrets]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.setOnePassword]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.revokeSecretSend]: AuthOrchestrationOperateScope,
  [SIGNALBOX_FOLDERS_WS_METHODS.setGitHubLend]: AuthOrchestrationOperateScope,
} as const;

export const FolderId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SignalboxFolderId"),
);
export type FolderId = typeof FolderId.Type;

const FolderName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** What agents can load beside a drive's own `AGENTS.md`: the Runner's limit. */
export const FOLDER_INSTRUCTIONS_MAX_LENGTH = 32 * 1024;
const Instructions = Schema.String.check(Schema.isMaxLength(FOLDER_INSTRUCTIONS_MAX_LENGTH));

/**
 * A 1Password Environment's id, as the desktop app's "Copy environment ID"
 * gives it. A level that names one gives the threads on its chain that
 * Environment's variables (#395). It's a reference, not a secret.
 */
export const OnePasswordEnvironmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("OnePasswordEnvironmentId"));
export type OnePasswordEnvironmentId = typeof OnePasswordEnvironmentId.Type;

/** Where a level's secrets come from: one 1Password Environment. */
export const FolderSecrets = Schema.Struct({ environmentId: OnePasswordEnvironmentId });
export type FolderSecrets = typeof FolderSecrets.Type;

/**
 * A host the person always lets agents send one of an Environment's secrets
 * to (#592). The first time an agent sends a secret to a new host, the thread
 * asks them; "Always" keeps one of these, and revoking it makes the next send
 * ask again. A host is a URL's host, with its port when it isn't the default.
 */
export const SecretSend = Schema.Struct({
  environmentId: OnePasswordEnvironmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(260)),
  grantedAt: NonNegativeInt,
});
export type SecretSend = typeof SecretSend.Type;
/** One stage a folder can be in, as people name it. */
export const FOLDER_PHASE_NAME_MAX_LENGTH = 48;
export const FolderPhaseName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FOLDER_PHASE_NAME_MAX_LENGTH),
);
const FOLDER_PHASES_MAX = 12;

/**
 * Where a folder is in its life (#677): `current`, one of its own `phases`,
 * which people edit freely. Separate from its threads' states.
 */
export const FolderPhase = Schema.Struct({
  /** In order, names unique ignoring case. */
  phases: Schema.Array(FolderPhaseName).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FOLDER_PHASES_MAX),
  ),
  current: FolderPhaseName,
});
export type FolderPhase = typeof FolderPhase.Type;

/**
 * The phases a new folder starts with, by the kind of tree it's in. A folder
 * made for files that already exist starts with none.
 */
export const FOLDER_PHASE_TEMPLATES = {
  organization: ["Proposal", "Initiative", "Implementation", "Testing", "Production"],
  personal: ["Idea", "Doing", "Done"],
} as const satisfies Record<SignalboxContext["kind"], ReadonlyArray<string>>;

const phaseKey = (name: string) => name.trim().toLocaleLowerCase();

/** `phases` as names, matched ignoring case: the one named `name`, if any. */
export const findFolderPhase = (phases: ReadonlyArray<string>, name: string) =>
  phases.find((phase) => phaseKey(phase) === phaseKey(name));

/** Why `phases` (trimmed) can't be a folder's, for the user; null when they can. */
export const folderPhasesProblem = (phases: ReadonlyArray<string>): string | null => {
  if (phases.length === 0) return "Add at least one phase, or remove the phase.";
  if (phases.length > FOLDER_PHASES_MAX)
    return `A folder can have up to ${FOLDER_PHASES_MAX} phases.`;
  if (phases.some((phase) => phase.length > FOLDER_PHASE_NAME_MAX_LENGTH)) {
    return `Keep each phase to ${FOLDER_PHASE_NAME_MAX_LENGTH} characters.`;
  }
  if (new Set(phases.map(phaseKey)).size !== phases.length) return "Each phase needs its own name.";
  return null;
};

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
  /** Its secrets: what threads in it and below get, over the same names from above. */
  secrets: Schema.optionalKey(FolderSecrets),
  /** Its phase. Absent: none, as for a folder already in production. */
  phase: Schema.optionalKey(FolderPhase),
  /**
   * The GitHub account the user lent to this folder: its automations' steps
   * on GitHub Actions run as it (#641). Absent: none lent, so they don't run.
   */
  githubLend: Schema.optionalKey(
    Schema.Struct({ login: TrimmedNonEmptyString, lentAt: NonNegativeInt }),
  ),
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
  top: Schema.Struct({
    instructions: Schema.optionalKey(Instructions),
    secrets: Schema.optionalKey(FolderSecrets),
  }),
  /**
   * The user's 1Password service account, which reads every level's
   * Environment when a thread starts. Absent: none connected, so no level's
   * secrets load. Its token never leaves the cloud but for the thread's machine.
   */
  onePassword: Schema.optionalKey(Schema.Struct({ connectedAt: NonNegativeInt })),
  /** The hosts agents may always send each secret to. Absent from a cloud older than this field. */
  secretSends: Schema.optionalKey(Schema.Array(SecretSend)),
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
  /**
   * The phases it starts with, at the first. Absent: its tree's template
   * (`FOLDER_PHASE_TEMPLATES`); null: none.
   */
  phases: Schema.optionalKey(Schema.NullOr(Schema.Array(FolderPhaseName))),
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

/**
 * Changes a folder's phase. `current` alone moves it to one of its phases,
 * matched ignoring case; skipping some is fine. `phases` replaces the list,
 * keeping the current phase when it's still in it, else starting at the
 * first. Null takes the phase away.
 */
export const FolderSetPhaseInput = Schema.Struct({
  id: FolderId,
  phases: Schema.optionalKey(Schema.NullOr(Schema.Array(FolderPhaseName))),
  current: Schema.optionalKey(FolderPhaseName),
});
export type FolderSetPhaseInput = typeof FolderSetPhaseInput.Type;

/** Replaces where a level's secrets come from; null stops loading secrets there. */
export const FolderSetSecretsInput = Schema.Struct({
  level: FolderLevel,
  secrets: Schema.NullOr(FolderSecrets),
});
export type FolderSetSecretsInput = typeof FolderSetSecretsInput.Type;

/** A 1Password service account token, as 1Password shows it once (`ops_…`). */
export const OnePasswordServiceAccountToken = TrimmedNonEmptyString.check(
  Schema.isMaxLength(16 * 1024),
  Schema.isStartingWith("ops_"),
);

/** Connects the user's 1Password service account, replacing any before; null disconnects it. */
export const FolderSetOnePasswordInput = Schema.Struct({
  token: Schema.NullOr(OnePasswordServiceAccountToken),
});
export type FolderSetOnePasswordInput = typeof FolderSetOnePasswordInput.Type;

/** Stops agents always sending one secret to one host: the next send asks again. */
export const FolderRevokeSecretSendInput = SecretSend.mapFields(
  ({ environmentId, name, host }) => ({ environmentId, name, host }),
);
export type FolderRevokeSecretSendInput = typeof FolderRevokeSecretSendInput.Type;

/** Lends the user's connected GitHub account to a folder's CI steps, or stops lending it. */
export const FolderSetGitHubLendInput = Schema.Struct({ id: FolderId, lent: Schema.Boolean });
export type FolderSetGitHubLendInput = typeof FolderSetGitHubLendInput.Type;

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
  change(SIGNALBOX_FOLDERS_WS_METHODS.setPhase, FolderSetPhaseInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.setSecrets, FolderSetSecretsInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.setOnePassword, FolderSetOnePasswordInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.revokeSecretSend, FolderRevokeSecretSendInput),
  change(SIGNALBOX_FOLDERS_WS_METHODS.setGitHubLend, FolderSetGitHubLendInput),
] as const;
