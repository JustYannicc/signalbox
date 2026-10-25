import {
  SIGNALBOX_TRASH_WS_METHODS,
  SignalboxTrashUnavailableError,
} from "@t3tools/contracts/signalboxTrash";
import * as Effect from "effect/Effect";

const unavailable = () => Effect.fail(new SignalboxTrashUnavailableError());

export const signalboxTrashWsHandlers = {
  [SIGNALBOX_TRASH_WS_METHODS.list]: unavailable,
  [SIGNALBOX_TRASH_WS_METHODS.thread]: unavailable,
  [SIGNALBOX_TRASH_WS_METHODS.folder]: unavailable,
  [SIGNALBOX_TRASH_WS_METHODS.restore]: unavailable,
  [SIGNALBOX_TRASH_WS_METHODS.empty]: unavailable,
};
