import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxDrive } from "@t3tools/contracts/signalboxDrives";
import { useState, type FormEvent } from "react";

import { environmentContextsAtom } from "../../state/signalboxContexts";
import { environmentDrivesAtom, signalboxDrives } from "../../state/signalboxDrives";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { driveCommandFailure } from "./driveCommandFailure";

/** A folder name for a drive: path-unsafe characters and spaces become dashes. */
export function shortcutFolderName(driveName: string): string {
  return driveName
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/^[.-]+|-+$/g, "");
}

/** Where a drive comes from, next to its name in the picker. */
function driveOrigin(drive: SignalboxDrive, contextName: string | undefined): string {
  const kind =
    drive.kind === "shared"
      ? "Shared drive"
      : drive.kind === "my"
        ? "My Drive"
        : drive.sharedBy
          ? `Shared by ${drive.sharedBy}`
          : "Shared with me";
  return contextName && drive.kind === "shared" ? `${contextName} · ${kind}` : kind;
}

/** Adds a shortcut to another drive as a new folder in `parentPath` of `drive`. */
export function AddDriveShortcutDialog(props: {
  environmentId: EnvironmentId;
  drive: SignalboxDrive;
  /** Folder the shortcut goes in, relative to the drive's root; "" for the root. */
  parentPath: string;
  onAdded: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const drives = useAtomValue(environmentDrivesAtom).get(props.environmentId);
  const contexts = useAtomValue(environmentContextsAtom).get(props.environmentId);
  const addShortcut = useAtomCommand(signalboxDrives.addShortcut, { reportFailure: false });
  const targets = (drives?.drives ?? []).filter((drive) => drive.id !== props.drive.id);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((drive) => drive.id === targetId);
  const folderName = name.trim();
  const nameError = folderName.includes("/") ? "Folder names can't contain /." : null;
  const where = props.parentPath ? props.parentPath.split("/").at(-1) : props.drive.name;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (target === undefined || !folderName || nameError !== null || pending) return;
    setPending(true);
    setError(null);
    const result = await addShortcut({
      environmentId: props.environmentId,
      input: {
        driveId: props.drive.id,
        path: props.parentPath ? `${props.parentPath}/${folderName}` : folderName,
        target: target.id,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(driveCommandFailure(result));
      return;
    }
    props.onAdded();
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) props.onOpenChange(open);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add shortcut</DialogTitle>
          <DialogDescription>
            Show another drive as a folder in {where}. It keeps its own access.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <DialogPanel>
            <div className="space-y-4">
              {targets.length === 0 ? (
                <p className="text-sm text-muted-foreground">There are no other drives to add.</p>
              ) : (
                <>
                  <label className="block space-y-1.5 text-sm font-medium">
                    Drive
                    <Select
                      value={targetId}
                      items={Object.fromEntries(targets.map((drive) => [drive.id, drive.name]))}
                      onValueChange={(value) => {
                        const next = targets.find((drive) => drive.id === value);
                        if (next === undefined) return;
                        setTargetId(next.id);
                        if (!nameEdited) setName(shortcutFolderName(next.name));
                      }}
                      disabled={pending}
                    >
                      <SelectTrigger aria-label="Drive">
                        <SelectValue placeholder="Choose a drive" />
                      </SelectTrigger>
                      <SelectPopup>
                        {targets.map((drive) => (
                          <SelectItem key={drive.id} value={drive.id}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{drive.name}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {driveOrigin(
                                  drive,
                                  contexts?.contexts.find(
                                    (context) => context.id === drive.contextId,
                                  )?.name,
                                )}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </label>
                  <label className="block space-y-1.5 text-sm font-medium">
                    Folder name
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameEdited(true);
                      }}
                      aria-invalid={nameError !== null || undefined}
                      disabled={pending}
                      required
                    />
                  </label>
                </>
              )}
              {(nameError ?? error) !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {nameError ?? error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || target === undefined || !folderName || nameError !== null}
            >
              {pending ? "Adding…" : "Add shortcut"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
