import {
  SIGNALBOX_TRASH_WS_METHODS,
  type TrashEmptyInput,
  type TrashFolderInput,
  type TrashRestoreInput,
  type TrashThreadInput,
} from "@t3tools/contracts/signalboxTrash";
import * as Effect from "effect/Effect";

import { UserTrash } from "./UserTrash.ts";

export const makeTrashHandlers = Effect.gen(function* () {
  const trash = yield* UserTrash;
  return {
    [SIGNALBOX_TRASH_WS_METHODS.list]: () => trash.list,
    [SIGNALBOX_TRASH_WS_METHODS.thread]: (input: typeof TrashThreadInput.Type) =>
      trash.trashThread(input),
    [SIGNALBOX_TRASH_WS_METHODS.folder]: (input: typeof TrashFolderInput.Type) =>
      trash.trashFolder(input),
    [SIGNALBOX_TRASH_WS_METHODS.restore]: (input: typeof TrashRestoreInput.Type) =>
      trash.restore(input),
    [SIGNALBOX_TRASH_WS_METHODS.empty]: (input: typeof TrashEmptyInput.Type) => trash.empty(input),
  };
});
