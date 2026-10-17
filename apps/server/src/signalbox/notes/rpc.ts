import {
  SIGNALBOX_NOTES_WS_METHODS,
  SignalboxNotesUnavailableError,
} from "@t3tools/contracts/signalboxNotes";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Notes live in Signalbox Cloud, beside the folders they're on. Clients only
 * ask an environment that advertises `capabilities.notes`.
 */
const unavailable = () => Effect.fail(new SignalboxNotesUnavailableError());

export const signalboxNotesWsHandlers = {
  [SIGNALBOX_NOTES_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxNotesUnavailableError()),
  [SIGNALBOX_NOTES_WS_METHODS.create]: unavailable,
  [SIGNALBOX_NOTES_WS_METHODS.update]: unavailable,
  [SIGNALBOX_NOTES_WS_METHODS.delete]: unavailable,
  [SIGNALBOX_NOTES_WS_METHODS.readAgain]: unavailable,
  [SIGNALBOX_NOTES_WS_METHODS.dismissReading]: unavailable,
  [SIGNALBOX_NOTES_WS_METHODS.accept]: unavailable,
};
