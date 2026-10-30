import { useAtomValue } from "@effect/atom-react";
import { captureDestinations } from "@t3tools/client-runtime/capture/destinations";
import { useState } from "react";
import { folderTreesAtom } from "../sidebar/folders/folderThreads";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { closeQuickCapture, restoreQuickCapture, useQuickCaptureStore } from "./quickCaptureStore";
import { QuickCaptureForm } from "./QuickCaptureForm";
import { useSaveCapture } from "./useSaveCapture";

export function QuickCaptureDialog({ open }: { readonly open: boolean }) {
  const [restore] = useState(() => useQuickCaptureStore.getState().restore);
  const [openCount] = useState(() => useQuickCaptureStore.getState().openCount);
  const [dismissRequest, setDismissRequest] = useState(0);
  const trees = useAtomValue(folderTreesAtom);
  const saveCapture = useSaveCapture();
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissRequest((value) => value + 1);
      }}
    >
      <CommandDialogPopup aria-label="Quick capture" data-quick-capture="">
        <QuickCaptureForm
          destinations={captureDestinations(trees.values())}
          initialCapture={restore}
          dismissRequest={dismissRequest}
          allowHideWhileSaving
          onSave={async (capture, show) => {
            const restoreIfHidden = () => {
              const current = useQuickCaptureStore.getState();
              if (current.open && current.openCount === openCount) return;
              restoreQuickCapture(capture);
            };
            try {
              const saved = await saveCapture(capture, {
                open: show,
                restoreOnFailure: false,
              });
              if (!saved) restoreIfHidden();
              return saved;
            } catch (cause) {
              restoreIfHidden();
              throw cause;
            }
          }}
          onClose={() => closeQuickCapture(openCount)}
        />
      </CommandDialogPopup>
    </CommandDialog>
  );
}
