import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxDrive, SignalboxDriveShortcut } from "@t3tools/contracts/signalboxDrives";
import { useState } from "react";

import { signalboxDrives } from "../../state/signalboxDrives";
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
import { driveCommandFailure } from "./driveCommandFailure";

/** Confirms removing a shortcut from `drive`. The drive it shows is untouched. */
export function RemoveDriveShortcutDialog(props: {
  environmentId: EnvironmentId;
  drive: SignalboxDrive;
  shortcut: SignalboxDriveShortcut;
  onRemoved: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const removeShortcut = useAtomCommand(signalboxDrives.removeShortcut, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = props.shortcut.name ?? props.shortcut.path.split("/").at(-1) ?? "the drive";

  const remove = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await removeShortcut({
      environmentId: props.environmentId,
      input: { driveId: props.drive.id, path: props.shortcut.path },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(driveCommandFailure(result));
      return;
    }
    props.onRemoved();
    props.onOpenChange(false);
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!pending) props.onOpenChange(open);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove shortcut to {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Threads in this drive stop seeing {name} from their next turn. {name} itself is
            untouched.
          </AlertDialogDescription>
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />} disabled={pending}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
            {pending ? "Removing…" : "Remove shortcut"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
