import { PaperclipIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import {
  findFolderTrigger,
  isOpenDraftShortcut,
  rankByLabel,
  removeTriggerText,
} from "@t3tools/client-runtime/capture/text";
import { cn, isMacPlatform, randomUUID } from "../../lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { CommandFooter, CommandFooterAction } from "../ui/command";
import { shouldHandleComposerAttachmentPaste } from "../chat/composerAttachmentFiles";
import { Kbd, KbdGroup } from "../ui/kbd";
import type { CaptureFile } from "./captureAttachments";
import type { Capture } from "./useSaveCapture";
import { CaptureChips, FolderSuggestions, SUGGESTIONS_ID } from "./QuickCaptureChoices";

import {
  CaptureDestinationUnavailableError,
  captureDefaultDestination,
  captureDestinationAvailable,
  selectCaptureFiles,
} from "./captureInput";

const MAX_SUGGESTIONS = 6;

export function QuickCaptureForm(props: {
  readonly destinations: ReadonlyArray<CaptureDestination>;
  readonly initialCapture?: Capture | null;
  readonly dismissRequest?: number;
  readonly footerAccessory?: ReactNode;
  readonly canSave?: boolean;
  readonly beforeSave?: (capture: Capture) => Promise<Capture>;
  readonly draftFiles?: ReadonlyArray<CaptureFile>;
  readonly onDraftChange?: (capture: Capture) => void | Promise<void>;
  readonly registerFlush?: (flush: () => Promise<void>) => () => void;
  readonly allowHideWhileSaving?: boolean;
  readonly onSave: (capture: Capture, open: boolean) => Promise<boolean>;
  readonly onClose: () => void;
  readonly requireDestination?: boolean;
  readonly onPreserveClose?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restore] = useState(props.initialCapture);
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
  const preparedRef = useRef(false);
  const preparation = useRef<Promise<Capture> | null>(null);
  const hideRequested = useRef(false);
  // The bar stays up as Saving… until the draft has everything; usually only a moment.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { destinations, registerFlush } = props;
  const [defaultDestination, setDefaultDestination] = useState(() =>
    captureDefaultDestination(restore?.destination ?? null, destinations),
  );
  const initialDestination = captureDefaultDestination(defaultDestination, destinations);
  if (initialDestination !== defaultDestination) setDefaultDestination(initialDestination);
  const destination = picked ?? initialDestination;
  const destinationBlocked =
    props.requireDestination === true && !captureDestinationAvailable(destination, destinations);
  const destinationError =
    "This capture's folder is unavailable. Reconnect its account or pick a folder to save.";

  const typedTrigger = findFolderTrigger(text, caret);
  const trigger = typedTrigger && typedTrigger.start !== dismissedAt ? typedTrigger : null;
  const query = trigger?.query ?? null;
  const suggestions = query === null ? [] : rankByLabel(destinations, query, MAX_SUGGESTIONS);
  const highlighted = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));
  const hasContent = text.trim().length > 0 || files.length > 0 || props.canSave === true;

  const persistDraft = useStableCallback((capture: Capture) => props.onDraftChange?.(capture));
  useEffect(() => {
    if (savedRef.current) return;
    const capture = { text, files: [...files, ...(props.draftFiles ?? [])], destination };
    void Promise.resolve()
      .then(() => {
        if (!savedRef.current) return persistDraft(capture);
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : "Couldn't keep this capture on this Mac.",
        ),
      );
  }, [text, files, destination, props.draftFiles, persistDraft]);

  const prepareCapture = (capture: Capture) => {
    const pending = Promise.resolve().then(async () => {
      const ready = props.beforeSave
        ? await props.beforeSave(capture)
        : { ...capture, files: [...capture.files, ...(props.draftFiles ?? [])] };
      await props.onDraftChange?.(ready);
      return ready;
    });
    preparation.current = pending;
    return pending;
  };
  const flushDraft = useStableCallback(async () => {
    // An in-flight submission already persists its immutable snapshot before enqueueing it.
    if (savedRef.current) {
      await preparation.current;
      return;
    }
    await prepareCapture({ text: textareaRef.current?.value ?? text, files, destination });
  });
  useLayoutEffect(() => registerFlush?.(flushDraft), [registerFlush, flushDraft]);

  const finish = (open: boolean, hiding = false) => {
    if (savedRef.current) {
      if (hiding && props.allowHideWhileSaving) {
        hideRequested.current = true;
        if (preparedRef.current) props.onClose();
      }
      return;
    }
    if (destinationBlocked) {
      setError(destinationError);
      if (hiding && props.onPreserveClose) {
        savedRef.current = true;
        setSaving(true);
        void prepareCapture({ text, files, destination })
          .then(() => {
            props.onPreserveClose?.();
          })
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : destinationError),
          )
          .finally(() => {
            savedRef.current = false;
            setSaving(false);
          });
      }
      return;
    }
    if (!open && !hasContent && !props.beforeSave) {
      savedRef.current = true;
      props.onClose();
      return;
    }
    savedRef.current = true;
    hideRequested.current = hiding && props.allowHideWhileSaving === true;
    preparedRef.current = false;
    setSaving(true);
    setError(null);
    const capture = { text, files, destination };
    const prepared = prepareCapture(capture);
    void prepared
      .then((ready) => {
        // A recording must finish before hiding can unmount its owner.
        preparedRef.current = true;
        if (hideRequested.current) props.onClose();
        if (!open && ready.text.trim().length === 0 && ready.files.length === 0) return true;
        return props.onSave(ready, open);
      })
      .then((saved) => {
        if (saved) props.onClose();
        else {
          savedRef.current = false;
          setSaving(false);
          setError("Couldn't save. Your capture is still here. Try again.");
        }
      })
      .catch((cause: unknown) => {
        savedRef.current = false;
        setSaving(false);
        setError(cause instanceof Error ? cause.message : "Couldn't save. Try again.");
        if (hiding && cause instanceof CaptureDestinationUnavailableError)
          props.onPreserveClose?.();
      });
  };
  const dismiss = useEffectEvent(() => finish(false, true));
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- External dismissal follows this surface's save/hide policy.
    if (props.dismissRequest) dismiss();
  }, [props.dismissRequest]);
  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

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
    const selected = selectCaptureFiles(incoming, fileCountRef.current);
    const kept = selected.files.map((file) => ({ id: randomUUID(), file }));
    fileCountRef.current += kept.length;
    setError(selected.message);
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
    <form
      className={cn("flex min-h-0 flex-col", dragging && "bg-accent/40")}
      onSubmit={(event) => {
        event.preventDefault();
        if (hasContent) finish(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || (event.key.toLowerCase() === "w" && event.metaKey)) {
          event.preventDefault();
          event.stopPropagation();
          finish(false, true);
        }
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
      {error || destinationBlocked ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {destinationBlocked ? destinationError : error}
        </p>
      ) : null}
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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Attach files"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon />
          </Button>
          {props.footerAccessory}
          <CommandFooterAction type="submit" disabled={!hasContent || saving || destinationBlocked}>
            <Kbd>↵</Kbd>
            Save
          </CommandFooterAction>
          <CommandFooterAction
            type="button"
            disabled={saving || destinationBlocked}
            onClick={() => finish(true)}
          >
            <KbdGroup>
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd>
            </KbdGroup>
            Open draft
          </CommandFooterAction>
        </span>
      </CommandFooter>
    </form>
  );
}
