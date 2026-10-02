/**
 * The Assistant: one coordinator chat that starts fresh each day (first open
 * after 4:00, or after a long idle stretch) and hands real work straight to the
 * agent that owns it. UI prototype on placeholder fixtures. The viewed day, the
 * new-day preview and the Customize tab live in the URL; the rest is local.
 */
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { EllipsisIcon, PhoneIcon, SmileIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AssistantComposer } from "./AssistantComposer";
import { AssistantCustomizeDialog, type CustomizeDialogTab } from "./AssistantCustomizeDialog";
import { AssistantIcon, useAssistantIdentity } from "./assistantIdentity";
import {
  CURRENT_DAY,
  dayDelegations,
  formatDayTitle,
  PAST_DAYS,
  resolveDay,
  type AssistantSearch,
} from "./assistantModel";
import { ChatHistoryMenu, OnlyYouChip } from "./ChatHeaderControls";
import { ChatWithTrace, ClosedChatNotice } from "./ChatWithTrace";
import { sendMockMessage } from "./mockChatStore";
import { NotificationMenu } from "./NotificationMenu";
import {
  SURFACE_HEADER_CONTAINER,
  SurfaceHeaderActions,
} from "../multiplayer/SurfaceHeaderActions";

const HISTORY = PAST_DAYS.map((day) => {
  const count = dayDelegations(day).length;
  return {
    id: day.date,
    title: formatDayTitle(day.date),
    meta: `${count} ${count === 1 ? "hand-off" : "hand-offs"}`,
  };
});

function CallButton(props: { name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Call ${props.name}`}
            render={<Link to="/assistant/call" />}
          />
        }
      >
        <PhoneIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Call {props.name}</TooltipPopup>
    </Tooltip>
  );
}

function OverflowMenu(props: {
  name: string;
  fresh: boolean;
  onFreshChange: (fresh: boolean) => void;
  onCustomize: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More" />}>
        <EllipsisIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuItem onClick={props.onCustomize}>
          <SmileIcon />
          Customize {props.name}…
        </MenuItem>
        {import.meta.env.DEV ? (
          <MenuCheckboxItem checked={props.fresh} onCheckedChange={props.onFreshChange}>
            Preview new-day screen
          </MenuCheckboxItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function AssistantPage() {
  const search = useSearch({ from: "/assistant/" });
  const navigate = useNavigate({ from: "/assistant/" });
  const { name } = useAssistantIdentity();
  const [traceOpen, setTraceOpen] = useState(false);
  const day = resolveDay(search.day);
  const isCurrent = day === CURRENT_DAY;
  const fresh = isCurrent && search.fresh === 1;
  const customizeTab = search.customize === "notifications" ? null : (search.customize ?? null);
  // One composer draft for both the new-day screen and the running chat.
  const [prompt, setPrompt] = useState(search.prompt ?? "");

  const go = useCallback((next: AssistantSearch) => void navigate({ search: next }), [navigate]);
  const setCustomizeTab = useCallback(
    (tab: CustomizeDialogTab | null) =>
      void navigate({
        search: (prev) => {
          const { customize: _closed, ...rest } = prev;
          return tab ? { ...rest, customize: tab } : rest;
        },
        replace: true,
      }),
    [navigate],
  );
  // `?prompt=` fills the composer once (adjusted during render, not in an effect),
  // then leaves the URL so a reload doesn't refill it.
  const [seenPrompt, setSeenPrompt] = useState(search.prompt);
  if (search.prompt !== seenPrompt) {
    setSeenPrompt(search.prompt);
    if (search.prompt !== undefined) setPrompt(search.prompt);
  }
  useEffect(() => {
    if (search.prompt === undefined) return;
    void navigate({
      search: (prev) => {
        const { prompt: _used, ...rest } = prev;
        return rest;
      },
      replace: true,
    });
  }, [navigate, search.prompt]);
  // Notification defaults moved to Settings; old links land there.
  useEffect(() => {
    if (search.customize === "notifications") void navigate({ to: "/settings/notifications" });
  }, [navigate, search.customize]);
  const backToCurrent = useCallback(() => go({}), [go]);
  // Sending from the new-day screen starts the day's conversation.
  const send = useCallback(
    (text: string, files: ReadonlyArray<File>) => {
      sendMockMessage({
        chatKey: `assistant:${CURRENT_DAY.date}`,
        text,
        files,
        speakerNodeId: "assistant",
      });
      if (fresh) go({});
    },
    [fresh, go],
  );
  const nameLabel = (
    <span className="flex min-w-0 items-center gap-2">
      <AssistantIcon />
      <WorkspaceBreadcrumbText>{name}</WorkspaceBreadcrumbText>
    </span>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className={SURFACE_HEADER_CONTAINER}>
          <WorkspaceBreadcrumb ariaLabel="Assistant breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem current={isCurrent}>
              {isCurrent ? (
                nameLabel
              ) : (
                <button
                  type="button"
                  onClick={backToCurrent}
                  className="min-w-0 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {nameLabel}
                </button>
              )}
            </WorkspaceBreadcrumbItem>
            {isCurrent ? null : (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <WorkspaceBreadcrumbText>{formatDayTitle(day.date)}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
          <div className="flex shrink-0 items-center gap-1">
            <OnlyYouChip agentName={name} />
            <CallButton name={name} />
            <NotificationMenu agentKey="assistant" agentName={name} />
            <ChatHistoryMenu
              groupLabel="Earlier days"
              entries={HISTORY}
              viewingId={isCurrent ? null : day.date}
              backLabel={`Back to ${name}`}
              onSelect={(date) => go(date ? { day: date } : {})}
            />
            <OverflowMenu
              name={name}
              fresh={fresh}
              onFreshChange={(next) => go(next ? { fresh: 1 } : {})}
              onCustomize={() => setCustomizeTab("identity")}
            />
            <SurfaceHeaderActions
              projectControls
              // Trace is this chat's side panel, so the panel toggle opens it.
              rightPanel={{ open: traceOpen, onOpenChange: setTraceOpen, label: "Trace" }}
            />
          </div>
        </WorkspacePageHeader>

        <ChatWithTrace
          key={`${day.date}:${fresh}`}
          chat={day}
          speaker={{ name, nodeId: "assistant" }}
          chatKey={`assistant:${day.date}`}
          traceOpen={traceOpen}
          onTraceOpenChange={setTraceOpen}
          fresh={fresh}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={send}
          footer={
            fresh ? undefined : isCurrent ? (
              <AssistantComposer
                recipient={name}
                targetKey="assistant"
                placeholder={`Ask ${name}, or hand something off`}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSend={send}
              />
            ) : (
              <ClosedChatNotice
                action={
                  <Button size="sm" variant="outline" onClick={backToCurrent}>
                    Back to {name}
                  </Button>
                }
              >
                A new chat started the next morning. Anything still open was carried over.
              </ClosedChatNotice>
            )
          }
        />
      </div>
      <AssistantCustomizeDialog tab={customizeTab} onTabChange={setCustomizeTab} />
    </SidebarInset>
  );
}
