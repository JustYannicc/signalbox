/**
 * The folder dialogs: name a new folder, rename one, confirm deleting one,
 * and edit a level's instructions (its AGENTS.md). Mounted once with the app
 * shell; `folderDialogStore` says which is open.
 */
import { FOLDER_INSTRUCTIONS_MAX_LENGTH } from "@t3tools/contracts/signalboxFolders";
import { useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { closeFolderDialog, useFolderDialogStore, type FolderDialog } from "./folderDialogStore";
import { useFolderCommands } from "./useFolderCommands";

const NAME_MAX_LENGTH = 128;
const numberFormat = new Intl.NumberFormat();

/** Runs `save` once at a time, closing the dialog when it succeeds. */
function usePendingSave() {
  const [pending, setPending] = useState(false);
  const run = async (save: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    try {
      if ((await save()) !== null) closeFolderDialog();
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

function NameDialog(props: { dialog: Extract<FolderDialog, { kind: "create" | "rename" }> }) {
  const { dialog } = props;
  const commands = useFolderCommands();
  const { pending, run } = usePendingSave();
  const [name, setName] = useState(dialog.kind === "rename" ? dialog.folder.name : "");
  const trimmed = name.trim();
  const unchanged = dialog.kind === "rename" && trimmed === dialog.folder.name;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (trimmed.length === 0) return;
    if (unchanged) return closeFolderDialog();
    void run(() =>
      dialog.kind === "create"
        ? commands.create(dialog.environmentId, {
            name: trimmed,
            parentId: dialog.parent?.id ?? null,
            ...(dialog.parent === null ? { ownerId: dialog.ownerId } : {}),
          })
        : commands.rename(dialog.environmentId, dialog.folder.id, trimmed),
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{dialog.kind === "create" ? "New folder" : "Rename folder"}</DialogTitle>
        <DialogDescription>
          {dialog.kind === "rename"
            ? `Choose a new name for “${dialog.folder.name}”.`
            : dialog.parent
              ? `Inside “${dialog.parent.name}”.`
              : `At the top of ${dialog.ownerName}.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form onSubmit={submit}>
          <Input
            aria-label="Folder name"
            autoFocus
            disabled={pending}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Folder name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </form>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={closeFolderDialog}>
          Cancel
        </Button>
        <Button disabled={pending || trimmed.length === 0} onClick={() => submit()}>
          {dialog.kind === "create" ? "Create folder" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

function DeleteDialog(props: { dialog: Extract<FolderDialog, { kind: "delete" }> }) {
  const { dialog } = props;
  const commands = useFolderCommands();
  const { pending, run } = usePendingSave();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete “{dialog.folder.name}”?</DialogTitle>
        <DialogDescription>{dialog.message}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={closeFolderDialog}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => void run(() => commands.remove(dialog.environmentId, dialog.folder))}
        >
          {pending ? "Deleting…" : "Delete folder"}
        </Button>
      </DialogFooter>
    </>
  );
}

function InstructionsDialog(props: { dialog: Extract<FolderDialog, { kind: "instructions" }> }) {
  const { dialog } = props;
  const commands = useFolderCommands();
  const { pending, run } = usePendingSave();
  const [text, setText] = useState(dialog.instructions);
  const nearLimit = text.length > FOLDER_INSTRUCTIONS_MAX_LENGTH * 0.9;
  const save = () => {
    if (text === dialog.instructions) return closeFolderDialog();
    void run(() => commands.setInstructions(dialog.environmentId, dialog.level, text));
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {dialog.name === null ? "Top-level instructions" : `Instructions for “${dialog.name}”`}
        </DialogTitle>
        <DialogDescription>
          {dialog.name === null
            ? "Every agent follows these first, then the instructions of each folder down to its thread's."
            : "Agents in this folder and below follow these, after the instructions of the levels above."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <Textarea
            aria-label="Instructions"
            autoFocus
            disabled={pending}
            maxLength={FOLDER_INSTRUCTIONS_MAX_LENGTH}
            placeholder="What should agents here know, and how should they work?"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {nearLimit
              ? `${numberFormat.format(text.length)} of ${numberFormat.format(FOLDER_INSTRUCTIONS_MAX_LENGTH)} characters.`
              : "Saved as this level's AGENTS.md. Leave it empty to remove it."}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={closeFolderDialog}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

export function FolderDialogs() {
  const open = useFolderDialogStore((state) => state.dialog !== null);
  const dialog = useFolderDialogStore((state) => state.shown);
  const openCount = useFolderDialogStore((state) => state.openCount);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeFolderDialog()}>
      <DialogPopup className={dialog?.kind === "instructions" ? "max-w-2xl" : "max-w-lg"}>
        {dialog === null ? null : dialog.kind === "create" || dialog.kind === "rename" ? (
          <NameDialog key={openCount} dialog={dialog} />
        ) : dialog.kind === "delete" ? (
          <DeleteDialog key={openCount} dialog={dialog} />
        ) : (
          <InstructionsDialog key={openCount} dialog={dialog} />
        )}
      </DialogPopup>
    </Dialog>
  );
}
