import {
  SIGNALBOX_DRIVES_WS_METHODS,
  type SignalboxDrive,
  type SignalboxDriveRole,
  type SignalboxDrivesSnapshot,
} from "@t3tools/contracts/signalboxDrives";
import type { ProjectId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Signalbox Cloud drives and the commands that manage their membership. */
export function createSignalboxDrivesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-drives:snapshot",
      tag: SIGNALBOX_DRIVES_WS_METHODS.subscribe,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-drives:create",
      tag: SIGNALBOX_DRIVES_WS_METHODS.create,
    }),
    members: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-drives:members",
      tag: SIGNALBOX_DRIVES_WS_METHODS.members,
    }),
    share: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-drives:share",
      tag: SIGNALBOX_DRIVES_WS_METHODS.share,
    }),
    unshare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-drives:unshare",
      tag: SIGNALBOX_DRIVES_WS_METHODS.unshare,
    }),
    shareFolder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-drives:share-folder",
      tag: SIGNALBOX_DRIVES_WS_METHODS.shareFolder,
    }),
  };
}

/** The drive represented by a project, if it is in this snapshot. */
export function driveOfProject(
  snapshot: SignalboxDrivesSnapshot | null,
  projectId: ProjectId,
): SignalboxDrive | undefined {
  return snapshot?.drives.find((drive) => drive.projectId === projectId);
}

const ROLE_LABELS: Record<SignalboxDriveRole, string> = {
  manager: "Manager",
  content_manager: "Content manager",
  contributor: "Contributor",
  commenter: "Commenter",
  viewer: "Viewer",
  owner: "Owner",
  editor: "Editor",
};

/** A readable role name for lists and controls. */
export function roleLabel(role: SignalboxDriveRole): string {
  return ROLE_LABELS[role];
}
