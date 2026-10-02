import { useNavigate } from "@tanstack/react-router";
import { LockIcon, Maximize2Icon, UsersIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { cn, isMacPlatform } from "../../lib/utils";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { Button } from "../ui/button";
import { CommandFooter } from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import {
  CAPTURE_SUGGESTIONS_ID,
  CaptureChipRow,
  CaptureSuggestionList,
  captureSuggestionId,
} from "./CaptureContext";
import {
  captureDraftHasContent,
  readCaptureDraft,
  useCaptureDraftStore,
} from "./captureDraftStore";
import { isOpenFullChatShortcut, openQuickCapture } from "./captureModel";
import {
  findActiveTrigger,
  isAssistantToken,
  removeTriggerText,
  routingHint,
  type CaptureToken,
} from "./captureTokens";
import { captureVisibility, visibilityLabel } from "./captureVisibility";
import { useCaptureAttachments } from "./useCaptureAttachments";
import { useCaptureSuggestions } from "./useCaptureSuggestions";
import { useOpenAsFullChat } from "./useOpenAsFullChat";

const CAPTURED_TOAST_ID = "quick-capture-done";

/**
 * The New bar: one calm text field. With the `@assistant` chip (preselected
 * unless you opened New in the app) Enter hands the text to the assistant's
 * capture workflow and mod+Enter opens it as a chat instead. Without the chip
 * (Backspace removes it) Enter starts a chat right away; see
 * `useOpenAsFullChat` for where. `#` (project, section, chat), `@` (person,
 * agent) and `+` (share) add chips; pasted links and dropped files too. Text,
 * chips, and links persist in `captureDraftStore` until sent.
 * PLACEHOLDER: captures only produce a toast; project chats are real T3 drafts.
 */
export function QuickCaptureForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const assistant = useAssistantIdentity();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = useCaptureDraftStore((state) => state.text);
  const tokens = useCaptureDraftStore((state) => state.tokens);
  const links = useCaptureDraftStore((state) => state.links);
  const [caret, setCaret] = useState(() => text.length);
  const [activeIndex, setActiveIndex] = useState(0);
  // Esc hides the list for the token being typed; typing elsewhere re-arms it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [isMac] = useState(() => isMacPlatform(navigator.platform));
  const attachments = useCaptureAttachments();

  const typedTrigger = findActiveTrigger(text, caret);
  const trigger = typedTrigger && typedTrigger.start !== dismissedAt ? typedTrigger : null;
  const suggestions = useCaptureSuggestions(trigger?.trigger ?? null, trigger?.query ?? "");
  const highlighted = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));

  const fullChat = useOpenAsFullChat(tokens);
  const visibility = captureVisibility(tokens);
  const VisibilityIcon = visibility.scope === "private" ? LockIcon : UsersIcon;
  const hasChips = tokens.length > 0 || links.length > 0 || attachments.files.length > 0;
  // The preselected assistant chip alone is nothing to send.
  const canCapture =
    text.trim().length > 0 ||
    links.length > 0 ||
    attachments.files.length > 0 ||
    tokens.some((token) => !isAssistantToken(token));

  const setText = (next: string, nextCaret: number) => {
    useCaptureDraftStore.getState().setText(next);
    setCaret(nextCaret);
  };

  const pick = (token: CaptureToken) => {
    if (!trigger) return;
    const next = removeTriggerText(text, trigger);
    setText(next.text, next.caret);
    // addTokens applies the `+private` / `+someone` exclusivity.
    useCaptureDraftStore.getState().addTokens([token]);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const capture = () => {
    if (!canCapture) return;
    const sent = readCaptureDraft();
    useCaptureDraftStore.getState().clear();
    toastManager.add({
      id: CAPTURED_TOAST_ID,
      type: "success",
      title: "Captured",
      timeout: 4000,
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(CAPTURED_TOAST_ID);
          void navigate({ to: "/assistant" });
        },
      },
      data: {
        secondaryActionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(CAPTURED_TOAST_ID);
            if (!captureDraftHasContent(readCaptureDraft())) {
              useCaptureDraftStore.getState().restore(sent);
            }
            openQuickCapture({ source: "resume" });
          },
        },
      },
    });
    onClose();
  };

  const openFullChat = (mode: "send" | "draft" = "draft") => {
    const prompt = [text.trim(), ...links.map((link) => link.url)].filter(Boolean).join("\n\n");
    if (attachments.files.length > 0) {
      toastManager.add({
        type: "info",
        title: "Files stay behind",
        description: "Attach them in the chat; New doesn't carry files over yet.",
      });
    }
    useCaptureDraftStore.getState().clear();
    onClose();
    void fullChat.openAsFullChat(prompt, mode);
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
    if (trigger && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(trigger.start);
      return;
    }
    if (isOpenFullChatShortcut(event, isMac)) {
      event.preventDefault();
      openFullChat();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // With the assistant chip, Enter hands it off; without, it starts a chat.
      if (fullChat.withAssistant) capture();
      else if (canCapture) openFullChat("send");
      return;
    }
    if (event.key === "Backspace" && text.length === 0 && tokens.length > 0) {
      useCaptureDraftStore.getState().removeToken(tokens.at(-1)!.id);
    }
  };

  return (
    <form
      className={cn("flex min-h-0 flex-col", attachments.dragging && "bg-accent/40")}
      onSubmit={(event) => {
        event.preventDefault();
        capture();
      }}
      {...attachments.dropHandlers}
    >
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <textarea
          ref={textareaRef}
          autoFocus
          rows={2}
          value={text}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onChange={(event) => {
            const { value, selectionStart } = event.target;
            setText(value, selectionStart);
            setActiveIndex(0);
            if (
              dismissedAt !== null &&
              findActiveTrigger(value, selectionStart)?.start !== dismissedAt
            ) {
              setDismissedAt(null);
            }
          }}
          onSelect={() => setCaret(textareaRef.current?.selectionStart ?? 0)}
          onKeyDown={handleKeyDown}
          onPaste={attachments.handlePaste}
          aria-label="New"
          aria-expanded={trigger !== null}
          aria-controls={trigger ? CAPTURE_SUGGESTIONS_ID : undefined}
          aria-activedescendant={
            trigger && suggestions.length > 0 ? captureSuggestionId(highlighted) : undefined
          }
          placeholder="What's on your mind?"
          className="field-sizing-content max-h-40 min-h-12 w-full resize-none bg-transparent text-base text-foreground outline-none placeholder:text-placeholder"
        />
        {trigger ? (
          <CaptureSuggestionList
            suggestions={suggestions}
            activeIndex={highlighted}
            onPick={pick}
            onHover={setActiveIndex}
          />
        ) : attachments.dragging ? (
          <p className="text-xs text-muted-foreground">Drop to attach</p>
        ) : (
          <>
            {hasChips ? (
              <CaptureChipRow
                tokens={tokens}
                links={links}
                files={attachments.files}
                onRemoveToken={(id) => useCaptureDraftStore.getState().removeToken(id)}
                onRemoveLink={(id) => useCaptureDraftStore.getState().removeLink(id)}
                onRemoveFile={attachments.removeFile}
              />
            ) : null}
            <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground/70">
              <span className="min-w-0 truncate">{routingHint(tokens, assistant.name)} ·</span>
              <VisibilityIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{visibilityLabel(visibility)}</span>
            </p>
          </>
        )}
      </div>
      <CommandFooter>
        {fullChat.withAssistant ? (
          <>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              Capture
            </span>
            <Button size="micro" variant="ghost-muted" onClick={() => openFullChat()}>
              <KbdGroup>
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
              <span className="min-w-0 truncate">{fullChat.label}</span>
            </Button>
          </>
        ) : (
          <>
            <Button size="micro" variant="ghost-muted" onClick={() => openFullChat("send")}>
              <Kbd>↵</Kbd>
              <span className="min-w-0 truncate">{fullChat.label}</span>
            </Button>
            <Button size="micro" variant="ghost-muted" onClick={() => openFullChat()}>
              <KbdGroup>
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
              <Maximize2Icon aria-hidden />
              Full screen
            </Button>
          </>
        )}
      </CommandFooter>
    </form>
  );
}
