/**
 * Every automation button sends one command and owns its failure: a toast
 * that says what didn't happen, and a busy flag to disable the control while
 * it's in flight. A cancelled command says nothing.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useAutomationCommand<W, A, E>(command: AtomCommand<W, A, E>, failureTitle: string) {
  const send = useAtomCommand(command, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  /** Resolves with the result on success, null after reporting a failure. Pass a title to override. */
  const run = useCallback(
    async (input: W, title = failureTitle): Promise<{ readonly value: A } | null> => {
      setBusy(true);
      const result = await send(input);
      setBusy(false);
      if (result._tag === "Success") return { value: result.value };
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title,
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return null;
    },
    [failureTitle, send],
  );
  return { run, busy };
}

/** Asks before something that can't be undone; the browser's own confirm where there's no dialog host. */
export async function confirmDestructive(message: string): Promise<boolean> {
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message)
  );
}
