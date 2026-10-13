/**
 * A section or project agent's persistent thread: work handed in from above,
 * the tasks it spun up, what it asked up for, and chats with the user. The
 * route's agent id is just a readable slug; everything here keys off the
 * level it represents (found in Home's level options). The agent coordinates
 * what lives at that level (threads, automations, places); it's shared with
 * the team in team levels and just yours otherwise. The chat resets once all
 * of its work is done; earlier chats live in History (`?chat=`). UI prototype.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { AgentAccess } from "../levels/AgentAccess";
import { AgentSharingChip } from "../levels/AgentSharingChip";
import { LevelCoordinates } from "../levels/LevelCoordinates";
import { useLevelOptions } from "../levels/LevelOptionsProvider";
import { useHomeProjectRefs } from "../levels/useHomeProjectRefs";
import { useMappedLeveledThings } from "../levels/useMappedLeveledThings";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { agentForLevel } from "./agentFixtures";
import { AgentInstructionsDialog } from "./AgentInstructionsDialog";
import { SupervisorAvatar } from "./AssistantGlyphs";
import { AssistantComposer } from "./AssistantComposer";
import { useAssistantIdentity } from "./assistantIdentity";
import { sendMockMessage } from "./mockChatStore";
import { ChatHistoryMenu } from "./ChatHeaderControls";
import { ChatWithTrace, ClosedChatNotice } from "./ChatWithTrace";
import { NotificationMenu } from "./NotificationMenu";
import {
  SURFACE_HEADER_CONTAINER,
  SurfaceHeaderActions,
} from "../multiplayer/SurfaceHeaderActions";

export function AgentPage(props: {
  agentId: string;
  chatId: string | null;
  /** Prefill for the composer (`?prompt=`). */
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(props.initialPrompt ?? "");
  const navigate = useNavigate({ from: "/agent/$agentId" });
  const { name: assistantName } = useAssistantIdentity();
  const [traceOpen, setTraceOpen] = useState(false);
  const mappedThings = useMappedLeveledThings();
  const levelOptions = useLevelOptions();
  const projects = useHomeProjectRefs();
  const level = useMemo(
    () => levelOptions.find((option) => option.agentId === props.agentId) ?? null,
    [props.agentId, levelOptions],
  );
  const agent = useMemo(
    () => agentForLevel(props.agentId, level, projects),
    [level, projects, props.agentId],
  );
  const agentId = props.agentId;
  const previous = agent.previous.find((chat) => chat.id === props.chatId);
  const chat = previous ?? agent.current;
  const levelName = level?.name ?? agent.name;
  const agentName = level?.agentName ?? `${levelName} agent`;

  const selectChat = useCallback(
    (chatId: string | null) => void navigate({ search: chatId ? { chat: chatId } : {} }),
    [navigate],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className={SURFACE_HEADER_CONTAINER}>
          <WorkspaceBreadcrumb ariaLabel="Agent breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem current={!previous}>
              <span className="flex min-w-0 items-center gap-2">
                <SupervisorAvatar agentId={agentId} size={20} />
                <WorkspaceBreadcrumbText>{agentName}</WorkspaceBreadcrumbText>
                {level ? (
                  <LevelCoordinates
                    level={level.key}
                    levelLabel={level.label}
                    agentName={agentName}
                  />
                ) : (
                  <WorkspaceBreadcrumbText className="font-normal text-muted-foreground max-sm:hidden">
                    · not in Home
                  </WorkspaceBreadcrumbText>
                )}
              </span>
            </WorkspaceBreadcrumbItem>
            {previous ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <WorkspaceBreadcrumbText>{previous.title}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="flex shrink-0 items-center gap-1">
            <AgentSharingChip level={level?.key ?? null} agentName={agentName} />
            <AgentAccess level={level?.key ?? null} mappedThings={mappedThings} />
            <AgentInstructionsDialog level={level} agentName={agentName} />
            <NotificationMenu agentKey={agentId} agentName={agentName} />
            <ChatHistoryMenu
              groupLabel="Earlier chats"
              entries={agent.previous.map(({ id, title, meta }) => ({ id, title, meta }))}
              viewingId={previous?.id ?? null}
              backLabel="Back to the current chat"
              onSelect={selectChat}
            />
            <SurfaceHeaderActions
              projectControls
              // Trace is this chat's side panel, so the panel toggle opens it.
              rightPanel={{ open: traceOpen, onOpenChange: setTraceOpen, label: "Trace" }}
            />
          </div>
        </WorkspacePageHeader>

        <ChatWithTrace
          key={chat.id}
          chat={chat}
          speaker={{
            name: agentName,
            nodeId: agent.nodeId,
            agentId,
          }}
          chatKey={`agent:${agentId}:${chat.id}`}
          traceOpen={traceOpen}
          onTraceOpenChange={setTraceOpen}
          empty={
            <div className="flex flex-col items-center gap-2 pt-20 text-center">
              <SupervisorAvatar agentId={agentId} size={56} />
              <h1 className="text-base font-semibold">Nothing open for {levelName}</h1>
              <p className="max-w-sm text-sm text-muted-foreground text-pretty">
                {`Work ${assistantName} hands down, the tasks this agent starts in ${levelName} and what it asks up for show up here. Message it to start something there.`}
              </p>
            </div>
          }
          footer={
            previous ? (
              <ClosedChatNotice
                action={
                  <Button size="sm" variant="outline" onClick={() => selectChat(null)}>
                    Back to the current chat
                  </Button>
                }
              >
                This chat closed once all of its work was done.
              </ClosedChatNotice>
            ) : (
              <AssistantComposer
                recipient={agentName}
                targetKey={`agent:${agentId}`}
                placeholder={`Message ${agentName}`}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSend={(text, files) =>
                  sendMockMessage({
                    chatKey: `agent:${agentId}:${chat.id}`,
                    text,
                    files,
                    speakerNodeId: agent.nodeId,
                  })
                }
              />
            )
          }
        />
      </div>
    </SidebarInset>
  );
}
