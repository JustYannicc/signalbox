/**
 * Quick capture (Todoist's quick add): one calm field. Enter saves what you
 * wrote as a draft without taking you anywhere, mod+Enter opens it as a full
 * draft, and closing it any other way keeps it as a draft too, so nothing
 * typed is ever lost. `#` files it in a folder; pasted or dropped files ride
 * along.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  FileIcon,
  FilmIcon,
  FolderIcon,
  HouseIcon,
  ImageIcon,
  MicIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import {
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn, isMacPlatform, randomUUID } from "../../lib/utils";
import { folderTreesAtom } from "../sidebar/folders/folderThreads";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandFooterAction,
} from "../ui/command";
import { shouldHandleComposerAttachmentPaste } from "../chat/composerAttachmentFiles";
import { Kbd, KbdGroup } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import type { CaptureFile } from "./captureAttachments";
import { captureDestinations, type CaptureDestination } from "./captureDestinations";
import {
  findFolderTrigger,
  isOpenDraftShortcut,
  rankByLabel,
  removeTriggerText,
} from "./captureText";
import { closeQuickCapture, useQuickCaptureStore } from "./quickCaptureStore";
import { useSaveCapture } from "./useSaveCapture";

const SUGGESTIONS_ID = "quick-capture-folders";
const MAX_SUGGESTIONS = 6;

/** One opening of quick capture; the host remounts it for each. */
export function QuickCaptureDialog(props: { readonly open: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Read once: each opening mounts afresh, from a failed save's text when there was one.
  const [restore] = useState(() => useQuickCaptureStore.getState().restore);
  const [openCount] = useState(() => useQuickCaptureStore.getState().openCount);
  const [text, setText] = useState(restore?.text ?? "");
  const [caret, setCaret] = useState(restore?.text.length ?? 0);
  const [picked, setPicked] = useState<CaptureDestination | null>(restore?.destination ?? null);
  const [files, setFiles] = useState<ReadonlyArray<CaptureFile>>(restore?.files ?? []);
  const [dragging, setDragging] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Esc hides the list for the tag being typed; typing another one re-arms it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [isMac] = useState(() => isMacPlatform(navigator.platform));
  // A second Enter (or a dismiss) during saving or the exit animation must not save twice.
  const savedRef = useRef(false);
  // The bar stays up as Saving… until the draft has everything; usually only a moment.
  const [saving, setSaving] = useState(false);
  const saveCapture = useSaveCapture();

  const trees = useAtomValue(folderTreesAtom);
  const destinations = useMemo(() => captureDestinations(trees.values()), [trees]);
  const destination = picked ?? destinations[0] ?? null;

  const typedTrigger = findFolderTrigger(text, caret);
  const trigger = typedTrigger && typedTrigger.start !== dismissedAt ? typedTrigger : null;
  const query = trigger?.query ?? null;
  const suggestions = useMemo(
    () => (query === null ? [] : rankByLabel(destinations, query, MAX_SUGGESTIONS)),
    [destinations, query],
  );
  const highlighted = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));
  const hasContent = text.trim().length > 0 || files.length > 0;

  /** `open`: go to the draft page, even with nothing written; otherwise only something written is kept. */
  const finish = (open: boolean) => {
    if (savedRef.current) return;
    savedRef.current = true;
    if (!open && !hasContent) {
      closeQuickCapture();
      return;
    }
    // Up until the draft holds it, even for plain text: draft creation can wait on settings.
    const saved = saveCapture({ text, files, destination }, { open });
    setSaving(true);
    // Only this opening: if it was dismissed and a failed save reopened it, leave that one up.
    void saved.finally(() => closeQuickCapture(openCount));
  };

  const updateText = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    setActiveIndex(0);
    if (dismissedAt !== null && findFolderTrigger(next, nextCaret)?.start !== dismissedAt) {
      setDismissedAt(null);
    }
  };

  const pick = (choice: CaptureDestination) => {
    if (!trigger || savedRef.current) return;
    const next = removeTriggerText(text, trigger);
    updateText(next.text, next.caret);
    setPicked(choice);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.caret, next.caret));
  };

  // Counted synchronously, so a drop and a paste in one tick are capped and reported against the same total.
  const fileCountRef = useRef(files.length);
  const addFiles = (incoming: ReadonlyArray<File>) => {
    // Once saving starts, what's being saved is fixed: a late file would show here and never reach the draft.
    if (incoming.length === 0 || savedRef.current) return;
    const room = Math.max(PROVIDER_SEND_TURN_MAX_ATTACHMENTS - fileCountRef.current, 0);
    const kept = incoming.slice(0, room).map((file) => ({ id: randomUUID(), file }));
    fileCountRef.current += kept.length;
    if (kept.length < incoming.length) {
      toastManager.add({
        type: "warning",
        title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files`,
      });
    }
    if (kept.length > 0) setFiles((current) => [...current, ...kept]);
  };

  const removeFile = (id: string) => {
    if (savedRef.current) return;
    fileCountRef.current -= 1;
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (trigger && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((highlighted + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[highlighted]!);
        return;
      }
    }
    // "No folder matches": Enter closes the list rather than saving a stray `#tag`.
    if (trigger && event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      setDismissedAt(trigger.start);
      return;
    }
    if (trigger && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(trigger.start);
      return;
    }
    if (isOpenDraftShortcut(event, isMac)) {
      event.preventDefault();
      finish(true);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (hasContent) finish(false);
      return;
    }
    if (event.key === "Backspace" && caret === 0 && picked !== null && !savedRef.current) {
      setPicked(null);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    const plainText = event.clipboardData.getData("text/plain");
    if (pasted.length === 0 || !shouldHandleComposerAttachmentPaste({ files: pasted, plainText })) {
      return;
    }
    event.preventDefault();
    addFiles(pasted);
  };

  const dropHandlers = {
    onDragOver: (event: DragEvent) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      setDragging(false);
      const dropped = Array.from(event.dataTransfer.files);
      if (dropped.length === 0) return;
      event.preventDefault();
      addFiles(dropped);
    },
  };

  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(next) => {
        if (next) return;
        // While saving, dismissing just hides the bar: the save carries on, and a failed one reopens it.
        if (saving) closeQuickCapture();
        // Esc, a click outside: keep what's written as a draft.
        else finish(false);
      }}
    >
      <CommandDialogPopup aria-label="Quick capture" data-quick-capture="">
        <form
          className={cn("flex min-h-0 flex-col", dragging && "bg-accent/40")}
          onSubmit={(event) => {
            event.preventDefault();
            if (hasContent) finish(false);
          }}
          {...dropHandlers}
        >
          <div className="flex flex-col gap-2.5 px-4 pt-4 pb-3">
            <textarea
              ref={textareaRef}
              autoFocus
              rows={2}
              value={text}
              onChange={(event) => updateText(event.target.value, event.target.selectionStart)}
              onSelect={() => setCaret(textareaRef.current?.selectionStart ?? 0)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              aria-label="Quick capture"
              aria-autocomplete="list"
              aria-expanded={trigger !== null}
              aria-controls={trigger ? SUGGESTIONS_ID : undefined}
              aria-activedescendant={
                trigger && suggestions.length > 0 ? `${SUGGESTIONS_ID}-${highlighted}` : undefined
              }
              readOnly={saving}
              placeholder="What's on your mind?"
              className="field-sizing-content max-h-48 min-h-12 w-full resize-none bg-transparent text-base text-foreground outline-none placeholder:text-placeholder"
            />
            {trigger ? (
              <FolderSuggestions
                suggestions={suggestions}
                activeIndex={highlighted}
                onPick={pick}
                onHover={setActiveIndex}
              />
            ) : dragging ? (
              <p className="text-xs text-muted-foreground">Drop to attach</p>
            ) : (
              <CaptureChips
                picked={picked}
                files={files}
                onUnpick={() => {
                  if (!savedRef.current) setPicked(null);
                }}
                onRemoveFile={removeFile}
              />
            )}
          </div>
          <CommandFooter>
            <span className="min-w-0 truncate text-xs" aria-live="polite">
              {saving ? (
                "Saving…"
              ) : (
                <>
                  {destination ? `Draft ${destination.inPlace}` : "Draft"}
                  <span className="text-muted-foreground/70"> · # to pick a folder</span>
                </>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <CommandFooterAction type="submit" disabled={!hasContent || saving}>
                <Kbd>↵</Kbd>
                Save
              </CommandFooterAction>
              <CommandFooterAction type="button" disabled={saving} onClick={() => finish(true)}>
                <KbdGroup>
                  <Kbd>{modKey}</Kbd>
                  <Kbd>↵</Kbd>
                </KbdGroup>
                Open draft
              </CommandFooterAction>
            </span>
          </CommandFooter>
        </form>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function FolderSuggestions(props: {
  readonly suggestions: ReadonlyArray<CaptureDestination>;
  readonly activeIndex: number;
  readonly onPick: (destination: CaptureDestination) => void;
  readonly onHover: (index: number) => void;
}) {
  if (props.suggestions.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No folder matches</p>;
  }
  return (
    <ul id={SUGGESTIONS_ID} role="listbox" aria-label="Folders" className="-mx-2 flex flex-col">
      {props.suggestions.map((suggestion, index) => {
        const Icon = suggestion.folderId === null ? HouseIcon : FolderIcon;
        return (
          <li
            key={suggestion.key}
            id={`${SUGGESTIONS_ID}-${index}`}
            role="option"
            aria-selected={index === props.activeIndex}
            // Keeps focus in the field while picking.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => props.onHover(index)}
            onClick={() => props.onPick(suggestion)}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
              index === props.activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
            {suggestion.detail ? (
              <span className="shrink-0 text-xs text-muted-foreground">{suggestion.detail}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function fileIcon(file: File): LucideIcon {
  if (file.type.startsWith("image/")) return ImageIcon;
  if (file.type.startsWith("audio/")) return MicIcon;
  if (file.type.startsWith("video/")) return FilmIcon;
  return FileIcon;
}

function CaptureChips(props: {
  readonly picked: CaptureDestination | null;
  readonly files: ReadonlyArray<CaptureFile>;
  readonly onUnpick: () => void;
  readonly onRemoveFile: (id: string) => void;
}) {
  if (props.picked === null && props.files.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.picked ? (
        <Chip
          icon={
            props.picked.folderId === null ? <HouseIcon aria-hidden /> : <FolderIcon aria-hidden />
          }
          label={`#${props.picked.label}`}
          onRemove={props.onUnpick}
        />
      ) : null}
      {props.files.map(({ id, file }) => {
        const Icon = fileIcon(file);
        return (
          <Chip
            key={id}
            icon={<Icon aria-hidden />}
            label={file.name}
            detail={formatAttachmentSize(file.size)}
            onRemove={() => props.onRemoveFile(id)}
          />
        );
      })}
    </div>
  );
}

function Chip(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail?: string;
  readonly onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" size="lg">
      {props.icon}
      <span className="max-w-48 truncate">{props.label}</span>
      {props.detail ? <span className="text-muted-foreground">{props.detail}</span> : null}
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-micro"
        aria-label={`Remove ${props.label}`}
        onClick={props.onRemove}
        className="-mr-1"
      >
        <XIcon />
      </Button>
    </Badge>
  );
}
