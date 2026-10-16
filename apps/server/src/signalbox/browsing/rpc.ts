import {
  SIGNALBOX_BROWSING_WS_METHODS,
  SignalboxBrowsingUnavailableError,
} from "@t3tools/contracts/signalboxBrowsing";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * A thread's synced tabs live in Signalbox Cloud. A self-hosted server keeps
 * its browser panel's tabs in memory (`preview/Manager.ts`), and clients only
 * ask an environment that advertises `capabilities.threadBrowsing`.
 */
export const signalboxBrowsingWsHandlers = {
  [SIGNALBOX_BROWSING_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxBrowsingUnavailableError()),
  [SIGNALBOX_BROWSING_WS_METHODS.dispatch]: (_input: {}) =>
    Effect.fail(new SignalboxBrowsingUnavailableError()),
};
