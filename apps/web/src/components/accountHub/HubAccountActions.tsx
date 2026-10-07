import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { UsageLimitSourceUpdateAccountInput } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { EllipsisIcon, PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : undefined;
};

/** Pause, resume, or remove an account a hub pools. Signing in again sits on the row. */
export function HubAccountActions({ account }: { readonly account: LimitAccount }) {
  const hub = account.hubAccount;
  const update = useAtomCommand(serverEnvironment.updateUsageLimitSourceAccount, {
    reportFailure: false,
  });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!hub) return null;
  const name = account.email ?? account.displayName ?? "this account";

  const run = async (action: UsageLimitSourceUpdateAccountInput["action"]) => {
    setConfirmRemove(false);
    setBusy(true);
    const result = await update({
      environmentId: hub.environmentId,
      input: { sourceId: hub.sourceId, accountId: hub.accountId, action },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: `Could not ${action} ${name}`,
        description: failureMessage(result),
      });
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" disabled={busy} />}
          aria-label={`Actions for ${name}`}
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {/* API keys have nothing to pause: the hub keeps them in its config. */}
          {hub.apiKey ? null : (
            <>
              <MenuItem onClick={() => void run(hub.disabled ? "resume" : "pause")}>
                {hub.disabled ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
                {hub.disabled ? "Resume" : "Pause"}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
            <Trash2Icon aria-hidden />
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Work stops using this account. To use it again, add it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void run("remove")}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
