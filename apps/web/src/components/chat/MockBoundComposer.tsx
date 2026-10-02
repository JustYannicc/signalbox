/**
 * The real chat composer's parts (surface, Tiptap prompt editor, send lock,
 * primary send button) for surfaces that have no server thread yet: prototypes
 * such as the assistant, agent chats and shared rooms. Sending hands the prompt
 * to `onSend`; nothing reaches a provider. `mentions` turns `@` into a people
 * picker (team chats, rooms), `tags` does the same for `#`; `banners` sit above
 * it like the chat composer's. `attachments` collects files as chips.
 */
import { PaperclipIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useComposerSendLockStore, useComposerSendLocked } from "../../composerSendLockStore";
import { cn } from "~/lib/utils";
import { CaptureChipRow } from "../capture/CaptureContext";
import { ComposerMentionRendererContext } from "../composerMentionRenderer";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { ComposerDraftContextRecords } from "../composerContextPresentation";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerSurface } from "./ComposerSurface";
import { MockComposerAgentControls } from "./MockComposerAgentControls";
import {
  useComposerMentionMenu,
  type ComposerMentionSource,
  type ComposerTagSource,
} from "./useComposerMentionMenu";
import { useMockComposerAttachments } from "./useMockComposerAttachments";

const NO_CONTEXT_RECORDS: ComposerDraftContextRecords = new Map();
const noop = () => {};

export function MockBoundComposer(props: {
  /** Send-lock key; keep it stable per surface, e.g. "assistant" or "agent:section-work". */
  targetKey: string;
  placeholder: string;
  /** Gets the prompt and any attached files; the chips clear after a send. */
  onSend: (prompt: string, files: ReadonlyArray<File>) => void;
  /** "large" is the roomier editor of a fresh chat. */
  size?: "default" | "large";
  /** Optional control, e.g. so suggestion chips can fill the prompt. */
  prompt?: string;
  onPromptChange?: (prompt: string) => void;
  /**
   * Show the real harness controls (provider/model picker, reasoning traits,
   * mode and access) for surfaces where a message starts or steers an agent run.
   * `true` is "full"; "model" stops at the model picker and traits. Off by
   * default, e.g. for rooms where people talk to people.
   */
  agentControls?: boolean | "model" | "full";
  /** Extra left-footer content, after the agent controls when those are on. */
  controls?: ReactNode;
  mentions?: ComposerMentionSource | undefined;
  /** `#` tags, e.g. projects, sections and chats. */
  tags?: ComposerTagSource | undefined;
  /** Paste, drop or pick files as removable chips; off keeps the "coming soon" paperclip. */
  attachments?: boolean;
  banners?: ReadonlyArray<ComposerBannerStackItem> | undefined;
}) {
  const [localPrompt, setLocalPrompt] = useState("");
  const prompt = props.prompt ?? localPrompt;
  const setPrompt = props.onPromptChange ?? setLocalPrompt;
  const [cursor, setCursor] = useState(prompt.length);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const sendLocked = useComposerSendLocked(props.targetKey);
  const attachments = useMockComposerAttachments(props.attachments === true);
  const hasText = prompt.trim().length > 0;
  const hasSendableContent = hasText || attachments.files.length > 0;
  const agentControls = props.agentControls === true ? "full" : props.agentControls || null;
  const mentionMenu = useComposerMentionMenu({
    source: props.mentions,
    tags: props.tags,
    prompt,
    applyPrompt: (nextPrompt, nextCursor) => {
      setPrompt(nextPrompt);
      setCursor(nextCursor);
      window.requestAnimationFrame(() => {
        editorRef.current?.focusAt(nextCursor);
      });
    },
  });

  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <form
          ref={formRef}
          className="relative z-10 mx-auto w-full min-w-0"
          data-chat-composer-form="true"
          {...attachments.dropHandlers}
          onSubmit={(event) => {
            event.preventDefault();
            if (!hasSendableContent || sendLocked) return;
            props.onSend(
              prompt,
              attachments.files.map((attached) => attached.file),
            );
            attachments.clear();
          }}
        >
          {props.banners && props.banners.length > 0 ? (
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                <ComposerBannerStack items={props.banners} />
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
          ) : null}
          <ComposerSurface.Main>
            <div
              className={cn(
                "rounded-3xl transition-[background-color] duration-200",
                attachments.dragging && "bg-accent/45 ring-1 ring-primary/70",
              )}
            >
              {attachments.files.length > 0 ? (
                <div className="px-3 pt-3 sm:px-4">
                  <CaptureChipRow
                    tokens={[]}
                    links={[]}
                    files={attachments.files}
                    onRemoveToken={noop}
                    onRemoveLink={noop}
                    onRemoveFile={attachments.removeFile}
                  />
                </div>
              ) : null}
              <div
                ref={mentionMenu.anchorRef}
                className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4"
              >
                {mentionMenu.menu}
                <ComposerMentionRendererContext value={mentionMenu.renderMention}>
                  <ComposerPromptEditor
                    editorRef={editorRef}
                    value={prompt}
                    cursor={Math.min(cursor, prompt.length)}
                    contextRecords={NO_CONTEXT_RECORDS}
                    skills={[]}
                    disabled={false}
                    placeholder={props.placeholder}
                    className={cn(props.size === "large" && "min-h-20")}
                    onChange={(nextValue, nextCursor, expandedCursor, adjacentToChip) => {
                      setPrompt(nextValue);
                      setCursor(nextCursor);
                      mentionMenu.onEditorChange(nextValue, expandedCursor, adjacentToChip);
                    }}
                    onCommandKeyDown={(key, event, isTaskItem) => {
                      if (mentionMenu.onCommandKey(key)) return true;
                      if (key !== "Enter" || event.shiftKey || isTaskItem || sendLocked)
                        return false;
                      formRef.current?.requestSubmit();
                      return true;
                    }}
                    onPaste={attachments.onPaste}
                  />
                </ComposerMentionRendererContext>
              </div>
              <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                <div className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {agentControls ? (
                    <MockComposerAgentControls
                      targetKey={props.targetKey}
                      prompt={prompt}
                      onPromptChange={setPrompt}
                      variant={agentControls}
                    />
                  ) : null}
                  {props.controls}
                </div>
                <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Attach files"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() =>
                            props.attachments
                              ? attachments.openPicker()
                              : toastManager.add({
                                  type: "info",
                                  title: "Attachments are coming soon",
                                })
                          }
                        />
                      }
                    >
                      <PaperclipIcon />
                    </TooltipTrigger>
                    <TooltipPopup>Attach files</TooltipPopup>
                  </Tooltip>
                  {props.attachments ? (
                    <input
                      ref={attachments.inputRef}
                      type="file"
                      multiple
                      hidden
                      tabIndex={-1}
                      onChange={(event) => attachments.onInputChange(event.currentTarget)}
                    />
                  ) : null}
                  <ComposerPrimaryActions
                    compact={false}
                    pendingAction={null}
                    isRunning={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={hasText}
                    isSendBusy={false}
                    sendDisabledReason={null}
                    sendLocked={sendLocked}
                    onToggleSendLock={() =>
                      useComposerSendLockStore.getState().toggleSendLocked(props.targetKey)
                    }
                    isConnecting={false}
                    isEnvironmentUnavailable={false}
                    isPreparingWorktree={false}
                    hasSendableContent={hasSendableContent}
                    onPreviousPendingQuestion={noop}
                    onInterrupt={noop}
                    onImplementPlanInNewThread={noop}
                  />
                </div>
              </div>
            </div>
          </ComposerSurface.Main>
        </form>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}
