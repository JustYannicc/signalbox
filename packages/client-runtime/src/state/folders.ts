import { SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export * from "./folderPhasesModel.ts";
export * from "./foldersModel.ts";

/**
 * A Signalbox Cloud user's folders, for one environment. Only environments
 * advertising `capabilities.folders` serve them; others keep their sections
 * (`sections.ts`).
 */
export function createSignalboxFoldersAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-folders:snapshot",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.subscribe,
    }),
    createFolder: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:create",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.create,
    }),
    updateFolder: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:update",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.update,
    }),
    moveFolder: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:move",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.move,
    }),
    deleteFolder: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:delete",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.delete,
    }),
    moveThread: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:move-thread",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.moveThread,
    }),
    setInstructions: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:set-instructions",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.setInstructions,
    }),
    setPhase: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:set-phase",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.setPhase,
    }),
    setSecrets: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:set-secrets",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.setSecrets,
    }),
    setOnePassword: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:set-one-password",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.setOnePassword,
    }),
    revokeSecretSend: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:revoke-secret-send",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.revokeSecretSend,
    }),
    setGitHubLend: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-folders:set-github-lend",
      tag: SIGNALBOX_FOLDERS_WS_METHODS.setGitHubLend,
    }),
  };
}
