import { useState } from "react";

import { closeFolderDialog } from "./folderDialogStore";

/** Runs `save` once at a time, closing the dialog when it succeeds. */
export function usePendingSave() {
  const [pending, setPending] = useState(false);
  const run = async (save: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    await (async () => {
      if ((await save()) !== null) closeFolderDialog();
    })().finally(() => {
      setPending(false);
    });
  };
  return { pending, run };
}
