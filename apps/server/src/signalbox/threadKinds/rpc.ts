import {
  SIGNALBOX_THREAD_KINDS_WS_METHODS,
  SignalboxThreadKindsUnavailableError,
} from "@t3tools/contracts/signalboxThreadKinds";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Chat and task kinds live in Signalbox Cloud, which classifies threads and
 * archives idle chats. Clients only ask an environment that advertises
 * `capabilities.threadKinds`.
 */
const unavailable = () => Effect.fail(new SignalboxThreadKindsUnavailableError());

export const signalboxThreadKindsWsHandlers = {
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxThreadKindsUnavailableError()),
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]: unavailable,
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays]: unavailable,
};
