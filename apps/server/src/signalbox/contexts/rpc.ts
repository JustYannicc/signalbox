import {
  SIGNALBOX_CONTEXTS_WS_METHODS,
  SignalboxContextsUnavailableError,
} from "@t3tools/contracts/signalboxContexts";
import * as Stream from "effect/Stream";

/**
 * Contexts live in Signalbox Cloud's user objects. A self-hosted server has
 * none, and clients only ask an environment that advertises
 * `capabilities.signalboxCloud`.
 */
export const signalboxContextsWsHandlers = {
  [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxContextsUnavailableError()),
};
