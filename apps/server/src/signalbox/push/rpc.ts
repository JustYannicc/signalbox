import {
  SIGNALBOX_PUSH_WS_METHODS,
  SignalboxPushUnavailableError,
} from "@t3tools/contracts/signalboxPush";
import * as Effect from "effect/Effect";

/**
 * Pushes from Signalbox Cloud go to the devices registered there. A
 * self-hosted server publishes through the T3 Connect relay instead, so the
 * phone's registration with it changes nothing; the app ignores this answer.
 */
export const signalboxPushWsHandlers = {
  [SIGNALBOX_PUSH_WS_METHODS.registerDevice]: (_input: {}) =>
    Effect.fail(new SignalboxPushUnavailableError()),
  [SIGNALBOX_PUSH_WS_METHODS.unregisterDevice]: (_input: {}) =>
    Effect.fail(new SignalboxPushUnavailableError()),
};
