/**
 * The native note page: a Notion-style editor for notes that live in a space
 * instead of a Google Doc. Blocks own their keys; this component owns the
 * block list, focus hand-off between blocks, and the note's surroundings
 * (where it lives, what agents see, and what references it).
 */
import { FolderTreeIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useRef, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { buildSpaceFiles } from "./spacesFiles";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import type { SpacesItemFixture } from "./spacesFixtures";
import { formatAge } from "./spacesModel";
import { SpacesEmptyState } from "./SpacesNotices";
import { SpacesNoteBacklinks } from "./SpacesNoteBacklinks";
import { SpacesNoteBlock, type NoteBlockActions } from "./SpacesNoteBlock";
import { block, noteArchiveKey, noteToItem, useSpacesNotes, type NoteBlock } from "./spacesNotes";
import { sectionSpace } from "./spacesSpace";

type FocusRequest = { readonly id: string; readonly caret: number | "end" };

function useNoteActions(noteId: string, onOpenItem: (item: SpacesItemFixture) => void) {
  const elements = useRef(new Map<string, HTMLElement>());

  const focus = useCallback((request: FocusRequest) => {
    const element = elements.current.get(request.id);
    if (!element) return;
    element.focus();
    if (element instanceof HTMLTextAreaElement) {
      const caret = request.caret === "end" ? element.value.length : request.caret;
      element.setSelectionRange(caret, caret);
    }
  }, []);

  // Created or retyped blocks remount; wait a frame so the new element exists.
  const focusAfterRender = useCallback(
    (request: FocusRequest) => requestAnimationFrame(() => focus(request)),
    [focus],
  );

  const registerRef = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  }, []);

  const actions = useMemo((): NoteBlockActions => {
    const store = useSpacesNotes.getState;
    const blocks = () => store().notes[noteId]?.blocks ?? [];
    const write = (next: readonly NoteBlock[], focusNext?: FocusRequest) => {
      store().updateNote(noteId, (note) => ({ ...note, blocks: next }));
      if (focusNext) focusAfterRender(focusNext);
    };
    const patch = (id: string, change: Partial<NoteBlock>, focusNext?: FocusRequest) =>
      write(
        blocks().map((entry) => (entry.id === id ? { ...entry, ...change } : entry)),
        focusNext,
      );
    return {
      change: (id, text) => patch(id, { text }),
      toggle: (id) => {
        const current = blocks().find((entry) => entry.id === id);
        patch(id, { checked: !current?.checked });
      },
      setType: (id, type, text) =>
        patch(id, { type, ...(text === undefined ? {} : { text }) }, { id, caret: "end" }),
      split: (id, caret) => {
        const list = blocks();
        const index = list.findIndex((entry) => entry.id === id);
        const current = list[index];
        if (!current) return;
        const listLike = current.type === "todo" || current.type === "bullet";
        if (listLike && current.text === "") {
          patch(id, { type: "paragraph" }, { id, caret: 0 });
          return;
        }
        const next = block(listLike ? current.type : "paragraph", current.text.slice(caret));
        write(list.toSpliced(index, 1, { ...current, text: current.text.slice(0, caret) }, next), {
          id: next.id,
          caret: 0,
        });
      },
      backspaceAtStart: (id) => {
        const list = blocks();
        const index = list.findIndex((entry) => entry.id === id);
        const current = list[index];
        const previous = list[index - 1];
        if (!current) return;
        if (current.type !== "paragraph") {
          patch(id, { type: "paragraph" }, { id, caret: 0 });
        } else if (previous?.type === "link") {
          if (current.text === "") write(list.toSpliced(index, 1), { id: previous.id, caret: 0 });
          else focus({ id: previous.id, caret: 0 });
        } else if (previous) {
          const merged = { ...previous, text: previous.text + current.text };
          write(list.toSpliced(index - 1, 2, merged), {
            id: previous.id,
            caret: previous.text.length,
          });
        }
      },
      move: (id, direction) => {
        const list = blocks();
        const target = list[list.findIndex((entry) => entry.id === id) + direction];
        if (target) focus({ id: target.id, caret: direction === -1 ? "end" : 0 });
      },
      link: (id, itemId) => {
        const list = blocks();
        const index = list.findIndex((entry) => entry.id === id);
        const after = block("paragraph");
        const chip: NoteBlock = { id, type: "link", text: "", itemId };
        write(list.toSpliced(index, 1, chip, after), { id: after.id, caret: 0 });
      },
      remove: (id) => {
        const list = blocks();
        const index = list.findIndex((entry) => entry.id === id);
        const neighbour = list[index - 1] ?? list[index + 1];
        const rest = list.toSpliced(index, 1);
        const fallback = block("paragraph");
        write(rest.length > 0 ? rest : [fallback], {
          id: neighbour?.id ?? fallback.id,
          caret: "end",
        });
      },
      openItem: onOpenItem,
    };
  }, [focus, focusAfterRender, noteId, onOpenItem]);

  const appendBlock = () => {
    const list = useSpacesNotes.getState().notes[noteId]?.blocks ?? [];
    const last = list.at(-1);
    if (last?.type === "paragraph" && last.text === "") return focus({ id: last.id, caret: 0 });
    const next = block("paragraph");
    useSpacesNotes.getState().updateNote(noteId, (note) => ({ ...note, blocks: [...list, next] }));
    focusAfterRender({ id: next.id, caret: 0 });
  };

  return { actions, registerRef, focus, appendBlock };
}

export function SpacesNoteEditor(props: {
  noteId: string;
  items: readonly SpacesItemFixture[];
  onOpenItem: (item: SpacesItemFixture) => void;
  onShowFile: (itemId: string) => void;
  onBack: () => void;
}) {
  const note = useSpacesNotes((state) => state.notes[props.noteId]);
  const updateNote = useSpacesNotes((state) => state.updateNote);
  const archiveKey = noteArchiveKey(props.noteId);
  const archived = useHomeSectionStore((state) => archiveKey in state.archived);
  const { actions, registerRef, focus, appendBlock } = useNoteActions(
    props.noteId,
    props.onOpenItem,
  );

  if (!note) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 pt-10">
        <SpacesEmptyState
          title="This page is gone"
          description="It was deleted, or it only existed until the last reload."
          action={
            <Button variant="outline" onClick={props.onBack}>
              Back to Spaces
            </Button>
          }
        />
      </div>
    );
  }

  const section = sectionSpace(note.space);
  const agentPath = (section ? buildSpaceFiles(section, [noteToItem(note)]) : []).find(
    (file) => file.itemId === note.id,
  )?.path;
  const onTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const first = note.blocks[0];
    if (event.key === "Enter" || (event.key === "ArrowDown" && first)) {
      event.preventDefault();
      if (first) focus({ id: first.id, caret: 0 });
      else appendBlock();
    }
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <article className="mx-auto flex w-full max-w-2xl flex-col px-6 pt-10 pb-24">
        {archived ? (
          <Alert>
            <AlertDescription>Archived. Hidden from your Spaces only.</AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                onClick={() => useHomeSectionStore.getState().setArchived(archiveKey, null)}
              >
                Restore
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        <textarea
          rows={1}
          value={note.title}
          placeholder="Untitled"
          aria-label="Page title"
          // A fresh page lands in its title, like a new doc does.
          autoFocus={note.title === "" && note.blocks.every((entry) => entry.text === "")}
          onChange={(event) => {
            const title = event.currentTarget.value.replaceAll("\n", " ");
            updateNote(note.id, (current) => ({ ...current, title }));
          }}
          onKeyDown={onTitleKeyDown}
          className="field-sizing-content mt-3 block w-full resize-none bg-transparent text-3xl font-semibold tracking-tight text-balance text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            Edited{" "}
            {formatAge(note.updatedAt) === "now" ? "just now" : `${formatAge(note.updatedAt)} ago`}
          </span>
        </div>
        {agentPath ? (
          <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Just Files</span>
            <code className="min-w-0 truncate font-mono text-foreground">{agentPath}</code>
            <Button size="xs" variant="ghost" onClick={() => props.onShowFile(note.id)}>
              <FolderTreeIcon />
              Show file
            </Button>
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-1.5">
          {note.blocks.map((entry) => (
            <SpacesNoteBlock
              key={entry.id}
              block={entry}
              noteId={note.id}
              items={props.items}
              registerRef={registerRef}
              actions={actions}
            />
          ))}
        </div>
        <div className="mt-2">
          <Button size="sm" variant="ghost-muted" onClick={appendBlock}>
            <PlusIcon />
            Add a block
          </Button>
        </div>

        <SpacesNoteBacklinks backlinks={note.backlinks} />
      </article>
    </ScrollArea>
  );
}
