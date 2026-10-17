/**
 * A level's scratch pad (#318): the author's words stay exactly as written, and
 * whoever reads them for that level offers what it thinks they meant
 * underneath, visibly its own. OK turns the note into a task there and takes
 * it off the pad; ignoring the offer leaves a plain note that never asks for
 * anything. Private by default; folders with a team can also share notes.
 * Mounted once with the app shell; `notesSheetStore` says which pad is open.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  acceptedMessage,
  canReadAgain,
  canShareWithTeam,
  conditionLabel,
  noteOffer,
  notesShown,
  otherVisibility,
  padNotes,
  readerNames,
} from "@t3tools/client-runtime/state/signalboxNotes";
import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import {
  NOTE_TEXT_MAX_LENGTH,
  type Note,
  type NoteVisibility,
} from "@t3tools/contracts/signalboxNotes";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  EllipsisIcon,
  LockIcon,
  RotateCcwIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type KeyboardEvent } from "react";

import { formatEnvironmentQueryError } from "../../state/query";
import { environmentContextsAtom } from "../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../state/signalboxFolders";
import { signalboxNotes } from "../../state/signalboxNotes";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useHomeModelSelection } from "../sidebar/folders/homeModelSelection";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { addsNote } from "./notesPadModel";
import { closeNotes, useNotesSheetStore, type NotesPad } from "./notesSheetStore";
import { type NoteCommands, useNoteCommands } from "./useNoteCommands";

function NoteMenu(props: {
  readonly note: Note;
  readonly shareable: boolean;
  readonly commands: NoteCommands;
}) {
  const { note, commands } = props;
  const readAgain = canReadAgain(note);
  const visibility = props.shareable ? otherVisibility(note) : null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="More for note" />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {readAgain ? (
          <MenuItem onClick={() => void commands.readAgain(note.id)}>
            <RotateCcwIcon />
            Read again
          </MenuItem>
        ) : null}
        {visibility === "team" ? (
          <MenuItem onClick={() => void commands.setVisibility(note.id, "team")}>
            <UsersIcon />
            Share with team
          </MenuItem>
        ) : visibility === "private" ? (
          <MenuItem onClick={() => void commands.setVisibility(note.id, "private")}>
            <LockIcon />
            Make private
          </MenuItem>
        ) : null}
        {readAgain || visibility !== null ? <MenuSeparator /> : null}
        <MenuItem variant="destructive" onClick={() => void commands.remove(note.id)}>
          <Trash2Icon />
          Delete
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

interface RowProps {
  readonly note: Note;
  /** The note's folder, null at the top level: who reads it is named after it. */
  readonly folderName: string | null;
  readonly shareable: boolean;
  readonly canWrite: boolean;
  readonly commands: NoteCommands;
  /** What a task started here runs on, read when accepting. */
  readonly startModel: () => ModelSelection | null;
  readonly openThread: (threadId: ThreadId) => void;
}

// Memoized so typing a new note doesn't re-render every row.
const NoteRow = memo(function NoteRow(props: RowProps) {
  const { note, folderName, commands } = props;
  const [pending, setPending] = useState(false);
  const offer = noteOffer(note);
  const reading = note.reading;
  const names = reading ? readerNames(reading.reader, folderName) : null;

  const accept = async () => {
    if (offer === null || pending) return;
    setPending(true);
    const result = await commands.accept(note.id, props.startModel());
    setPending(false);
    if (result === null) return;
    const message = acceptedMessage(offer, folderName);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: message.title,
        description: message.description,
        actionProps: { children: "Trace", onClick: () => props.openThread(result.threadId) },
      }),
    );
  };

  const dismiss = async () => {
    if (pending) return;
    setPending(true);
    await commands.dismiss(note.id);
    setPending(false);
  };

  return (
    <li className="group/note flex flex-col gap-1.5 py-2.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap text-foreground text-pretty wrap-anywhere">
          {note.text}
        </p>
        {props.canWrite ? (
          <span className="shrink-0 opacity-0 group-focus-within/note:opacity-100 group-hover/note:opacity-100 group-has-data-popup-open/note:opacity-100 pointer-coarse:opacity-100">
            <NoteMenu note={note} shareable={props.shareable} commands={commands} />
          </span>
        ) : null}
      </div>
      {offer !== null && names !== null ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2 transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none">
          <p className="text-xs text-muted-foreground">{names.subject} reads this as</p>
          <p className="text-sm text-muted-foreground text-pretty">
            {offer.meaning}
            {offer.condition ? (
              <span className="ml-1.5 inline-flex rounded-md border border-border px-1.5 text-xs">
                {conditionLabel(offer.condition)}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground text-pretty">{offer.action}</p>
          {props.canWrite ? (
            <div className="flex gap-1">
              <Button size="xs" variant="outline" disabled={pending} onClick={() => void accept()}>
                <CheckIcon />
                OK, do it
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending}
                onClick={() => void dismiss()}
              >
                Not this
              </Button>
            </div>
          ) : null}
        </div>
      ) : reading?._tag === "unclear" && names !== null ? (
        <p className="text-xs text-muted-foreground">
          {names.subject} isn't sure what this means yet. It'll stay a note.
        </p>
      ) : null}
    </li>
  );
});

function VisibilityToggle(props: {
  value: NoteVisibility;
  onChange: (visibility: NoteVisibility) => void;
}) {
  return (
    <div className="flex gap-0.5" role="group" aria-label="Who sees these notes">
      <Button
        size="xs"
        variant={props.value === "private" ? "secondary" : "ghost-muted"}
        aria-pressed={props.value === "private"}
        onClick={() => props.onChange("private")}
      >
        <LockIcon />
        Only you
      </Button>
      <Button
        size="xs"
        variant={props.value === "team" ? "secondary" : "ghost-muted"}
        aria-pressed={props.value === "team"}
        onClick={() => props.onChange("team")}
      >
        <UsersIcon />
        Team
      </Button>
    </div>
  );
}

function NotesPadView(props: { pad: NotesPad }) {
  const { pad } = props;
  const { environmentId, home } = pad;
  const commands = useNoteCommands(environmentId);
  const homeModelSelection = useHomeModelSelection();
  const navigate = useNavigate();
  const folders = useAtomValue(environmentFoldersAtom).get(environmentId)?.snapshot ?? null;
  const contexts = useAtomValue(environmentContextsAtom).get(environmentId);
  const canWrite = useAtomValue(signalboxNotes.createNote.permissionAtom(environmentId));
  const result = useAtomValue(signalboxNotes.snapshot({ environmentId, input: {} }));
  const [visibility, setVisibility] = useState<NoteVisibility>("private");
  const [draft, setDraft] = useState("");

  const folder =
    home._tag === "folder"
      ? (folders?.folders.find((candidate) => candidate.id === home.folderId) ?? null)
      : null;
  const folderName = folder?.name ?? null;
  const place =
    home._tag === "top"
      ? (contexts?.contexts.find((context) => context.id === PERSONAL_CONTEXT_ID)?.name ??
        "Top level")
      : folderName;
  const shareable = canShareWithTeam(folder);
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const error =
    result._tag === "Failure" && snapshot === null
      ? formatEnvironmentQueryError(result.cause)
      : null;
  const notes = useMemo(
    () => (snapshot === null ? null : notesShown(padNotes(snapshot, home), shareable, visibility)),
    [home, shareable, snapshot, visibility],
  );
  const folderId = home._tag === "folder" ? home.folderId : null;
  const startModel = useCallback(
    () => homeModelSelection(environmentId, folderId),
    [environmentId, folderId, homeModelSelection],
  );
  const openThread = useCallback(
    (threadId: ThreadId) => {
      closeNotes();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    },
    [environmentId, navigate],
  );

  const add = async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    const added = await commands.create(home, text, shareable ? visibility : "private");
    // Give the words back unless something new was typed meanwhile.
    if (added === null) setDraft((current) => (current === "" ? text : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      addsNote({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
      })
    ) {
      event.preventDefault();
      void add();
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Scratch pad</SheetTitle>
        {place === null ? null : <SheetDescription>{place}</SheetDescription>}
      </SheetHeader>
      <section aria-label="Notes" className="flex min-h-0 flex-1 flex-col gap-2 px-6 pb-6">
        <div className="flex items-center">
          {shareable ? (
            <VisibilityToggle value={visibility} onChange={setVisibility} />
          ) : (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <LockIcon className="size-3" />
              Only you
            </span>
          )}
        </div>
        {canWrite ? (
          <Textarea
            size="sm"
            autoFocus
            value={draft}
            maxLength={NOTE_TEXT_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              shareable && visibility === "team"
                ? "Jot something the team can see"
                : "Jot something, half-formed is fine"
            }
            aria-label="New note"
          />
        ) : null}
        {error !== null ? (
          <p className="py-2 text-xs text-muted-foreground">Couldn't load notes. {error}</p>
        ) : notes === null ? null : notes.length > 0 ? (
          <ul className="flex min-h-0 flex-col divide-y divide-border overflow-y-auto">
            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                folderName={folderName}
                shareable={shareable}
                canWrite={canWrite}
                commands={commands}
                startModel={startModel}
                openThread={openThread}
              />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">
            {canWrite ? "Nothing here. Enter adds a note." : "Nothing here."}
          </p>
        )}
      </section>
    </>
  );
}

export function NotesSheet() {
  const open = useNotesSheetStore((state) => state.pad !== null);
  const pad = useNotesSheetStore((state) => state.shown);
  const openCount = useNotesSheetStore((state) => state.openCount);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && closeNotes()}>
      <SheetPopup side="right">
        {pad === null ? null : <NotesPadView key={openCount} pad={pad} />}
      </SheetPopup>
    </Sheet>
  );
}
