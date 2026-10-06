import {
  SIGNALBOX_CONTEXTS_WS_METHODS,
  SignalboxContextsUnavailableError,
} from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const unavailable = () => Effect.fail(new SignalboxContextsUnavailableError());

/**
 * Contexts and sections live in Signalbox Cloud's user objects. A self-hosted
 * server has neither, and clients only ask an environment that advertises
 * `capabilities.signalboxCloud`.
 */
export const signalboxContextsWsHandlers = {
  [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxContextsUnavailableError()),
  [SIGNALBOX_CONTEXTS_WS_METHODS.createSection]: unavailable,
  [SIGNALBOX_CONTEXTS_WS_METHODS.renameSection]: unavailable,
  [SIGNALBOX_CONTEXTS_WS_METHODS.moveSection]: unavailable,
  [SIGNALBOX_CONTEXTS_WS_METHODS.deleteSection]: unavailable,
};
