import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  type SignalboxDriveKind,
  type SignalboxDriveRole,
} from "@t3tools/contracts/signalboxDrives";

/**
 * Drive ids and who may do what in a drive. An id names the drive's kind and
 * the context it belongs to, so anyone holding one knows which organization's
 * membership it needs without asking the drive:
 *
 *   my/<context>/<user id>       a person's My Drive in a context
 *   shared/<context>/<key>       a work organization's shared drive
 *   folder/<context>/<key>       a folder split out of a My Drive to share it
 *
 * Roles follow Google Drive (see `signalboxDrives.ts` in the contracts).
 */

export interface DriveName {
  readonly kind: SignalboxDriveKind;
  readonly contextId: SignalboxContextId;
  /** A My Drive's owner, named by its id. */
  readonly owner: string | null;
}

export const myDriveId = (contextId: SignalboxContextId, userId: string) =>
  `my/${contextId}/${userId}`;

export const sharedDriveId = (contextId: SignalboxContextId, key: string) =>
  `shared/${contextId}/${key}`;

export const folderDriveId = (contextId: SignalboxContextId, key: string) =>
  `folder/${contextId}/${key}`;

const DRIVE_ID = /^(my|shared|folder)\/([^/]+)\/([^/]+)$/;

export function parseDriveId(driveId: string): DriveName | null {
  const match = DRIVE_ID.exec(driveId);
  if (match === null) return null;
  const kind = match[1] as SignalboxDriveKind;
  return {
    kind,
    contextId: SignalboxContextId.make(match[2]!),
    owner: kind === "my" ? match[3]! : null,
  };
}

/**
 * Whether someone in `contextIds` may reach a drive of `contextId` at all. A
 * work organization's drives need its membership; Personal drives need only
 * a grant, since everyone has a Personal context.
 */
export const contextAllows = (
  contextIds: ReadonlyArray<SignalboxContextId>,
  contextId: SignalboxContextId,
) => contextId === PERSONAL_CONTEXT_ID || contextIds.includes(contextId);

const WRITERS: ReadonlySet<SignalboxDriveRole> = new Set([
  "manager",
  "content_manager",
  "contributor",
  "owner",
  "editor",
]);

/** Whether `role` changes files: starts threads that work in the drive. */
export const canWrite = (role: SignalboxDriveRole | null) => role !== null && WRITERS.has(role);
