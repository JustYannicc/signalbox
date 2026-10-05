/**
 * One-click feedback from the rail: click, type, Send (or Enter). Shift+Enter
 * adds a line. A screenshot of the window and recent server warnings and
 * errors ride along unless unchecked. The draft survives a failed send so
 * nothing typed is lost. Builds without a feedback DSN show the button
 * disabled with the reason.
 */
import { ImageOffIcon, MessageSquareHeartIcon } from "lucide-react";
import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { APP_BASE_NAME } from "../../../branding";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { SidebarMenuButton } from "../../ui/sidebar";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { readFeedbackServerLogs } from "./feedbackServerLogs";
import { FEEDBACK_DSN, preloadFeedbackSdk, sendFeedback } from "./sendFeedback";
import { useFeedbackScreenshot, type FeedbackScreenshot } from "./useFeedbackScreenshot";

const SCREENSHOT_WAIT_MS = 10_000;

function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(resolve, ms, null))]);
}

function ScreenshotPreview(props: { enabled: boolean; screenshot: FeedbackScreenshot }) {
  const { screenshot } = props;
  let content: ReactNode;
  if (props.enabled && screenshot.status === "ready") {
    content = (
      <img
        src={screenshot.url}
        alt="Screenshot that will be attached"
        className="size-full object-cover object-left-top"
      />
    );
  } else if (props.enabled && screenshot.status !== "failed") {
    content = "Capturing…";
  } else {
    content = (
      <ImageOffIcon
        aria-label={props.enabled ? "Screenshot unavailable" : "No screenshot"}
        className="size-4"
      />
    );
  }
  return (
    <div className="flex aspect-video h-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-xs text-muted-foreground">
      {content}
    </div>
  );
}

function AttachmentOption(props: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
      {props.children}
    </label>
  );
}

export function SidebarFeedbackButton() {
  const textareaId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachScreenshot, setAttachScreenshot] = useState(true);
  const [attachLogs, setAttachLogs] = useState(true);
  const {
    screenshot,
    start: captureScreenshot,
    clear: clearScreenshot,
    resolve: resolveScreenshot,
  } = useFeedbackScreenshot();

  // Each open captures what is on screen right then; closing drops it.
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) preloadFeedbackSdk();
    if (next && attachScreenshot) captureScreenshot();
    else if (!next) clearScreenshot();
  };
  const changeAttachScreenshot = (checked: boolean) => {
    setAttachScreenshot(checked);
    if (checked && open) captureScreenshot();
    else if (!checked) clearScreenshot();
  };
  const canSend = draft.trim().length > 0 && !sending;

  const resolveAttachments = async () => {
    const [screenshotBlob, serverLogs] = await Promise.all([
      // A slow capture drops the screenshot rather than holding up Send.
      attachScreenshot ? withTimeout(resolveScreenshot(), SCREENSHOT_WAIT_MS) : null,
      attachLogs ? readFeedbackServerLogs() : null,
    ]);
    return { screenshot: screenshotBlob, serverLogs };
  };

  const submit = async () => {
    const message = draft.trim();
    if (message.length === 0 || sending) return;
    setSending(true);
    try {
      await sendFeedback({
        message,
        ...(await resolveAttachments()),
      });
      setDraft("");
      changeOpen(false);
      toastManager.add({ type: "success", title: "Feedback sent", description: "Thanks." });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't send feedback",
        description: error instanceof Error ? error.message : "Something went wrong.",
      });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  if (!FEEDBACK_DSN) {
    return (
      <Tooltip>
        {/* A disabled button gets no pointer events, so the tooltip hangs off a wrapper. */}
        <TooltipTrigger render={<span className="flex" />}>
          <SidebarMenuButton aria-label="Send feedback" size="icon" disabled>
            <MessageSquareHeartIcon />
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipPopup side="right">Feedback isn't set up on this build</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<SidebarMenuButton aria-label="Send feedback" size="icon" isActive={open} />}
            />
          }
        >
          <MessageSquareHeartIcon />
        </TooltipTrigger>
        <TooltipPopup side="right">Send feedback</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="right" align="end" width="md" padding="compact">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor={textareaId} className="text-sm font-medium text-foreground">
              Feedback about {APP_BASE_NAME}
            </label>
            <Textarea
              id={textareaId}
              autoFocus
              value={draft}
              disabled={sending}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Bug, idea, annoyance…"
            />
          </div>
          <div className="flex items-center gap-3">
            <ScreenshotPreview enabled={attachScreenshot} screenshot={screenshot} />
            <div className="flex flex-col gap-2">
              <AttachmentOption
                checked={attachScreenshot}
                disabled={sending}
                onCheckedChange={changeAttachScreenshot}
              >
                Attach screenshot
              </AttachmentOption>
              <AttachmentOption
                checked={attachLogs}
                disabled={sending}
                onCheckedChange={setAttachLogs}
              >
                Attach recent server logs
              </AttachmentOption>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Shift+Enter for a new line</p>
            <Button type="submit" size="sm" disabled={!canSend}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
