/**
 * Body shared by the assistant and agent pages: the chat column opened at its
 * latest message (fixtures plus anything sent locally), a footer (composer or
 * closed notice), and the Trace panel.
 */
import { useState, type ReactNode } from "react";

import { ScrollArea } from "../ui/scroll-area";
import type { ChatFixture, DelegationFixture } from "./assistantFixtures";
import { AssistantConversation, type ChatSpeaker } from "./AssistantConversation";
import { AssistantFreshStart } from "./AssistantFreshStart";
import { dayDelegations, delegationTarget, statusDisplay } from "./assistantModel";
import { AssistantTracePanel } from "./AssistantTracePanel";
import { localTurns, useMockChatVersion } from "./mockChatStore";
import { chatNotifications } from "./NotificationRow";

const scrollIntoView = (node: HTMLDivElement | null) => node?.scrollIntoView({ block: "end" });

/** Trace opens on whatever needs the user, else on nothing. */
function initialTraceNode(delegations: readonly DelegationFixture[]): string | null {
  const waiting = delegations.findLast(
    (delegation) => statusDisplay(delegation.status, delegation.waitingOn).needsYou,
  );
  return (waiting && delegationTarget(waiting)?.id) ?? null;
}

export function ChatWithTrace(props: {
  /** Keys this chat's locally sent messages (see `mockChatStore`). */
  chatKey: string;
  chat: ChatFixture;
  speaker: ChatSpeaker;
  traceOpen: boolean;
  onTraceOpenChange: (open: boolean) => void;
  footer?: ReactNode | undefined;
  /** Show the assistant's new-day screen instead of the conversation. */
  fresh?: boolean;
  /** The new-day screen's composer draft, owned by the page. */
  prompt?: string;
  onPromptChange?: (prompt: string) => void;
  /** Sends from the new-day screen's composer. */
  onSend?: (text: string, files: ReadonlyArray<File>) => void;
  /** Shown instead of the conversation when the chat has no turns. */
  empty?: ReactNode;
}) {
  const { onTraceOpenChange } = props;
  useMockChatVersion();
  const sent = localTurns(props.chatKey);
  const chat = { ...props.chat, turns: [...props.chat.turns, ...sent] };
  // The new-day screen shows only what was carried over.
  const delegations = dayDelegations(props.fresh ? { ...chat, turns: [] } : chat);
  const [selectedNodeId, setSelectedNodeId] = useState(() => initialTraceNode(delegations));
  const notifications = chatNotifications(chat);

  const showInTrace = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    onTraceOpenChange(true);
  };
  const closeTrace = () => onTraceOpenChange(false);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col px-5 pt-6 pb-8 sm:px-6">
            {props.fresh ? (
              <AssistantFreshStart
                chat={chat}
                onTrace={showInTrace}
                {...(props.prompt !== undefined ? { prompt: props.prompt } : {})}
                {...(props.onPromptChange ? { onPromptChange: props.onPromptChange } : {})}
                onSend={props.onSend ?? (() => {})}
              />
            ) : props.empty && chat.turns.length === 0 ? (
              props.empty
            ) : (
              <AssistantConversation chat={chat} speaker={props.speaker} onTrace={showInTrace} />
            )}
            {/* A chat opens at its latest message and follows new ones: the marker
                remounts per message and scrolls itself into view. */}
            <div key={sent.length} ref={scrollIntoView} />
          </div>
        </ScrollArea>
        {props.footer ? <div className="shrink-0 px-5 pb-4 sm:px-6">{props.footer}</div> : null}
      </div>
      {props.traceOpen ? (
        <AssistantTracePanel
          delegations={delegations}
          notifications={notifications}
          selectedNodeId={selectedNodeId}
          onSelect={setSelectedNodeId}
          onClose={closeTrace}
        />
      ) : null}
    </div>
  );
}

/** The footer for a chat that is over: why it closed and the way back. */
export function ClosedChatNotice(props: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-wrap items-center justify-between gap-3 rounded-2xl border border-border px-4 py-3">
      <p className="text-sm text-muted-foreground">{props.children}</p>
      {props.action}
    </div>
  );
}
