import {
  SIGNALBOX_FOLDERS_WS_METHODS,
  SignalboxFoldersUnavailableError,
} from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Folders live in Signalbox Cloud. A self-hosted server keeps its sections
 * (`sections/`), and clients only ask an environment that advertises
 * `capabilities.folders`.
 */
const unavailable = () => Effect.fail(new SignalboxFoldersUnavailableError());

export const signalboxFoldersWsHandlers = {
  [SIGNALBOX_FOLDERS_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxFoldersUnavailableError()),
  [SIGNALBOX_FOLDERS_WS_METHODS.create]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.update]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.move]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.delete]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.moveThread]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.setInstructions]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.setSecrets]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.setOnePassword]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.revokeSecretSend]: unavailable,
  [SIGNALBOX_FOLDERS_WS_METHODS.setGitHubLend]: unavailable,
};
