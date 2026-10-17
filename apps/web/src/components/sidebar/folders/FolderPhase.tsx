/**
 * A folder's phase (#677) in the tree: the current one beside its name, the
 * ⋯ menu's Phase submenu to move it, and the dialog that edits the list.
 */
import {
  FOLDER_PHASE_TEMPLATE_CHOICES,
  folderPhaseEdit,
  folderPhasesEditorText,
  folderPhaseTemplateText,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { Folder } from "@t3tools/contracts/signalboxFolders";
import { MilestoneIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../../ui/dialog";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../ui/menu";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../../lib/utils";
import { closeFolderDialog, openFolderDialog, type FolderDialog } from "./folderDialogStore";
import { type FolderCommands, useFolderCommands } from "./useFolderCommands";
import { usePendingSave } from "./usePendingSave";

/** The folder's current phase, quiet beside its name; nothing when it has none. */
export function FolderPhaseLabel(props: { folder: Folder }) {
  const phase = props.folder.phase;
  if (phase === undefined) return null;
  // Doesn't shrink below its width (up to the cap): next to a status roll-up the name truncates first.
  return (
    <span className="max-w-[45%] shrink-0 truncate text-2xs text-sidebar-muted-foreground/55">
      <span className="sr-only">, phase </span>
      {phase.current}
    </span>
  );
}

/** Moves the folder to another of its phases, or opens the editor; "Add phases…" without any. */
export function FolderPhaseMenuItems(props: {
  environmentId: EnvironmentId;
  folder: Folder;
  ownerKind: SignalboxContext["kind"];
  commands: FolderCommands;
}) {
  const { environmentId, folder, ownerKind, commands } = props;
  const edit = () => openFolderDialog({ kind: "phases", environmentId, folder, ownerKind });
  if (folder.phase === undefined) {
    return (
      <MenuItem onClick={edit}>
        <MilestoneIcon />
        Add phases…
      </MenuItem>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger>
        <MilestoneIcon />
        Phase
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup
          value={folder.phase.current}
          onValueChange={(current) =>
            void commands.setPhase(environmentId, { id: folder.id, current })
          }
        >
          {folder.phase.phases.map((phase) => (
            <MenuRadioItem key={phase} value={phase}>
              {phase}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={edit}>Edit phases…</MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Its phases, one per line, with the templates to start from and a way to remove them. */
export function FolderPhasesDialog(props: { dialog: Extract<FolderDialog, { kind: "phases" }> }) {
  const { dialog } = props;
  const { folder } = dialog;
  const commands = useFolderCommands();
  const { pending, run } = usePendingSave();
  const [text, setText] = useState(() => folderPhasesEditorText(folder.phase, dialog.ownerKind));
  const edit = folderPhaseEdit(folder.phase, text);
  const save = (input: Parameters<FolderCommands["setPhase"]>[1]) =>
    void run(() => commands.setPhase(dialog.environmentId, input));
  const submit = () => {
    if (edit.problem !== null) return;
    if (edit.unchanged) return closeFolderDialog();
    save({
      id: folder.id,
      phases: edit.phases,
      ...(edit.current === undefined ? {} : { current: edit.current }),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Phases for “{folder.name}”</DialogTitle>
        <DialogDescription>
          Where this folder is in its life, separate from its threads. Change the current phase from
          the folder's menu, or let an automation move it.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <Textarea
            aria-label="Phases, one per line"
            autoFocus
            disabled={pending}
            placeholder={"Proposal\nImplementation\nProduction"}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span>One per line, in order. Start from</span>
            {FOLDER_PHASE_TEMPLATE_CHOICES.map((template) => (
              <Button
                key={template.kind}
                size="micro"
                variant="outline"
                disabled={pending}
                onClick={() => setText(folderPhaseTemplateText(template.kind))}
              >
                {template.label}
              </Button>
            ))}
          </div>
          <p
            role={edit.problem === null ? undefined : "alert"}
            className={cn(
              "text-xs",
              edit.problem === null ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {edit.status}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter>
        {folder.phase === undefined ? null : (
          <Button
            className="sm:me-auto"
            variant="ghost-destructive"
            disabled={pending}
            onClick={() => save({ id: folder.id, phases: null })}
          >
            Remove phases
          </Button>
        )}
        <Button variant="outline" disabled={pending} onClick={closeFolderDialog}>
          Cancel
        </Button>
        <Button disabled={pending || edit.problem !== null} onClick={submit}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
