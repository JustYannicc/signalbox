import {
  SIGNALBOX_THREAD_STATUS_WS_METHODS,
  SignalboxThreadStatusUnavailableError,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Stream from "effect/Stream";

/**
 * Status notes live in Signalbox Cloud, where every turn's agent writes them.
 * Clients only ask an environment that advertises `capabilities.threadStatusNotes`;
 * a self-hosted thread shows the code half of its status line.
 */
export const signalboxThreadStatusWsHandlers = {
  [SIGNALBOX_THREAD_STATUS_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxThreadStatusUnavailableError()),
};
