import {
  SIGNALBOX_DRIVES_WS_METHODS,
  SignalboxDrivesUnavailableError,
} from "@t3tools/contracts/signalboxDrives";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Drives live in Signalbox Cloud. A self-hosted server's projects are plain
 * directories, and clients only ask an environment that advertises
 * `capabilities.signalboxCloud`.
 */
const unavailable = () => Effect.fail(new SignalboxDrivesUnavailableError());

export const signalboxDrivesWsHandlers = {
  [SIGNALBOX_DRIVES_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxDrivesUnavailableError()),
  [SIGNALBOX_DRIVES_WS_METHODS.create]: unavailable,
  [SIGNALBOX_DRIVES_WS_METHODS.members]: unavailable,
  [SIGNALBOX_DRIVES_WS_METHODS.share]: unavailable,
  [SIGNALBOX_DRIVES_WS_METHODS.unshare]: unavailable,
  [SIGNALBOX_DRIVES_WS_METHODS.shareFolder]: unavailable,
};
