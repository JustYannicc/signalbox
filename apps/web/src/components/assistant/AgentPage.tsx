/**
 * A section or project agent's persistent thread: work handed in from above,
 * what it passed on, and chats with the user. The chat resets once all of its
 * work is done; earlier chats live in History (`?chat=`). UI prototype.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { resolveAgent } from "./agentFixtures";
import { AgentInstructionsDialog } from "./AgentInstructionsDialog";
import { SupervisorAvatar } from "./AssistantGlyphs";
import { AssistantComposer } from "./AssistantComposer";
import { useAssistantIdentity } from "./assistantIdentity";
import { sendMockMessage } from "./mockChatStore";
import { ChatHistoryMenu, OnlyYouChip } from "./ChatHeaderControls";
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
  const agent = resolveAgent(props.agentId);
  const previous = agent.previous.find((chat) => chat.id === props.chatId);
  const chat = previous ?? agent.current;
  const agentName = `${agent.name} agent`;

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
                <SupervisorAvatar agentId={agent.id} size={20} />
                <WorkspaceBreadcrumbText>{agentName}</WorkspaceBreadcrumbText>
                <WorkspaceBreadcrumbText className="font-normal text-muted-foreground max-sm:hidden">
                  · {agent.scope}
                </WorkspaceBreadcrumbText>
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
            <OnlyYouChip agentName={agentName} />
            <AgentInstructionsDialog agent={agent} agentName={agentName} />
            <NotificationMenu agentKey={agent.id} agentName={agentName} />
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
            agentId: agent.id,
          }}
          chatKey={`agent:${agent.id}:${chat.id}`}
          traceOpen={traceOpen}
          onTraceOpenChange={setTraceOpen}
          empty={
            <div className="flex flex-col items-center gap-2 pt-20 text-center">
              <SupervisorAvatar agentId={agent.id} size={56} />
              <h1 className="text-base font-semibold">Nothing open for {agent.name}</h1>
              <p className="max-w-sm text-sm text-muted-foreground text-pretty">
                {agent.kind === "workflow"
                  ? "Runs that need you show up here. Everything else stays quiet."
                  : `Work ${assistantName} hands to ${agent.name} shows up here. You can also message this agent directly.`}
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
                targetKey={`agent:${agent.id}`}
                placeholder={`Message ${agentName}`}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSend={(text, files) =>
                  sendMockMessage({
                    chatKey: `agent:${agent.id}:${chat.id}`,
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
