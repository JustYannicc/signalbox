/**
 * Top-bar controls for a native note: the standard access bar (a note shares
 * like any item and starts from its section's default scope) and the ⋯ menu
 * to move, archive or delete it. Archive uses the personal Home archive, so
 * the page is restorable from Home › Archived.
 */
import { ArchiveIcon, EllipsisIcon, FolderInputIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";

import { useAccessItem, type AccessItemBase } from "../multiplayer/itemAccess";
import { defaultScopeFor } from "../multiplayer/sharing";
import { currentPerson } from "../multiplayer/teamThreads";
import { ThreadAccessBar } from "../multiplayer/ThreadAccessBar";
import { useAccessControls } from "../multiplayer/useAccessControls";
import { archiveInHome } from "../sidebar/sections/sectionStore";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { sectionPathLabel, type HomeSection } from "../sidebar/sections/sectionModel";
import { noteArchiveKey, noteTitle, useSpacesNotes, type SpacesNote } from "./spacesNotes";

function NoteAccessBar(props: { note: SpacesNote }) {
  const { id, space } = props.note;
  const title = noteTitle(props.note);
  const base = useMemo(
    (): AccessItemBase => ({
      id,
      title,
      // Access items are chats, tasks or rooms; a page shares like a chat.
      kind: "chat",
      containerId: space,
      ownerIds: [currentPerson.id],
      repliedIds: [],
      initialVisibility: defaultScopeFor(space),
    }),
    [id, space, title],
  );
  return <ThreadAccessBar controls={useAccessControls(useAccessItem(base))} />;
}

export function SpacesNoteHeaderActions(props: {
  note: SpacesNote;
  sections: readonly HomeSection[];
  /** Called after the note leaves this view (archived or deleted). */
  onLeave: () => void;
}) {
  const { note } = props;
  const title = noteTitle(note);
  const store = useSpacesNotes.getState;

  const move = (sectionId: string) => {
    store().updateNote(note.id, (current) => ({ ...current, space: sectionId }));
    toastManager.add({ type: "success", title: `Moved to ${sectionPathLabel(sectionId)}` });
  };
  const archive = () => {
    archiveInHome(noteArchiveKey(note.id), title, "Note");
    props.onLeave();
  };
  const remove = () => {
    const removed = store().deleteNote(note.id);
    props.onLeave();
    toastManager.add({
      type: "success",
      title: `Deleted ${title}`,
      timeout: 5000,
      actionProps: {
        children: "Undo",
        onClick: () => {
          if (removed) store().restoreNote(removed);
        },
      },
    });
  };

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <NoteAccessBar note={note} />
      <Menu>
        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Page options" />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuSub>
            <MenuSubTrigger>
              <FolderInputIcon />
              Move to
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup value={note.space} onValueChange={(value) => move(String(value))}>
                {props.sections.map((section) => (
                  <MenuRadioItem key={section.id} value={section.id}>
                    {sectionPathLabel(section.id)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuItem onClick={archive}>
            <ArchiveIcon />
            Archive
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={remove}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
