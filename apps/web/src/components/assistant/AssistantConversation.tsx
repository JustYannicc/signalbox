/**
 * One chat with the assistant or an agent: carried-over items, then turns.
 * Hand-offs, read-only lookups and work arriving from other agents render inline.
 * Notifications that were sent show as one quiet line; skipped ones live in Trace.
 */
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BugIcon,
  CalendarIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  GitBranchIcon,
  MailIcon,
  PaperclipIcon,
  TicketIcon,
  WorkflowIcon,
} from "lucide-react";

import { formatFileSize } from "../capture/captureTokens";
import { MessageText } from "../multiplayer/MessageText";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import type { AssistantBlock, ChatFixture, LookupFixture, TurnFixture } from "./assistantFixtures";
import { NodeGlyph, NodeName, SupervisorAvatar } from "./AssistantGlyphs";
import { AssistantIcon } from "./AssistantIcon";
import { useAssistantIdentity } from "./assistantIdentity";
import { findDelegation, findNode } from "./assistantModel";
import { CarriedOver } from "./CarriedOver";
import { DelegationCard } from "./DelegationCard";
import { NotificationRow } from "./NotificationRow";

type OnTrace = (nodeId: string) => void;

/** Who answers in this chat: the assistant, or a section or project agent. */
export interface ChatSpeaker {
  readonly name: string;
  /** The speaker's trace node, so its own hop is left out of routes. */
  readonly nodeId: string;
  /** Set for section and project agents; the assistant uses the user's avatar. */
  readonly agentId?: string;
}

const TURN_AVATAR_SIZE = 28;

/** The speaker looks busy on a turn that handed off work still in progress. */
function turnIsWorking(turn: TurnFixture): boolean {
  return turn.blocks.some(
    (block) =>
      block.kind === "delegation" && findDelegation(block.delegationId)?.status === "working",
  );
}

const blockKey = (block: AssistantBlock) =>
  block.kind === "text"
    ? `text:${block.text}`
    : block.kind === "lookup"
      ? `lookup:${block.lookup.query}`
      : block.kind === "automation"
        ? `automation:${block.automationId}`
        : block.kind === "notification"
          ? `notification:${block.nodeId}:${block.reason}`
          : `delegation:${block.delegationId}`;

/** Skipped notifications stay out of the chat; Trace shows them on their node. */
const isShown = (block: AssistantBlock) =>
  block.kind !== "notification" || block.delivery !== "none";

const isNotificationOnly = (turn: TurnFixture) =>
  turn.blocks.every((block) => block.kind === "notification");

const LOOKUP_ICON = {
  gmail: MailIcon,
  calendar: CalendarIcon,
  jira: TicketIcon,
  sentry: BugIcon,
  github: GitBranchIcon,
} as const;

/** A link card to the automation a workflow agent runs. */
function AutomationLink(props: { automationId: string; label: string }) {
  return (
    <Link
      to="/automations/$automationId"
      params={{ automationId: props.automationId }}
      className="flex items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <WorkflowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">Open workflow </span>
        <span className="font-medium">{props.label}</span>
      </span>
      <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

function LookupRow(props: { lookup: LookupFixture }) {
  const { lookup } = props;
  const Icon = LOOKUP_ICON[lookup.tool];
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/lookup flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{lookup.account}</span>
        <ChevronDownIcon
          aria-hidden
          className="ms-auto size-3 shrink-0 transition-transform group-data-panel-open/lookup:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-1.5 px-2 pt-1 pb-2 text-xs text-muted-foreground">
          <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {lookup.query}
          </code>
          <span>Read-only. {lookup.result}</span>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function turnText(turn: TurnFixture): string {
  return turn.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
}

function UserTurn(props: { turn: TurnFixture }) {
  const { name } = useAssistantIdentity();
  const files = props.turn.files ?? [];
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex max-w-[80%] flex-col gap-2 rounded-2xl bg-message px-3.5 py-2.5 whitespace-pre-wrap text-message-foreground">
        <h3 className="sr-only">You</h3>
        {turnText(props.turn) ? (
          <MessageText body={turnText(props.turn)} ownAssistantName={name} />
        ) : null}
        {files.length > 0 ? (
          <ul aria-label="Attached files" className="flex flex-wrap gap-1.5">
            {files.map((file) => (
              <li
                key={file.name}
                className="flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-xs"
              >
                <PaperclipIcon aria-hidden className="size-3 shrink-0" />
                <span className="max-w-48 truncate">{file.name}</span>
                <span className="text-muted-foreground">{formatFileSize(file.size)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <span className="pe-1 text-xs text-muted-foreground tabular-nums">{props.turn.at}</span>
    </div>
  );
}

/** Work arriving from another agent, labelled with who actually sent it. */
function HandoffTurn(props: { turn: TurnFixture }) {
  const from = props.turn.from ? findNode(props.turn.from) : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border px-3.5 py-2.5">
      <h3 className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CornerDownRightIcon aria-hidden className="size-3" />
        Delegated by
        {from ? <NodeGlyph node={from} className="text-foreground" /> : null}
        <span className="font-medium text-foreground">
          {from ? <NodeName node={from} /> : "another agent"}
        </span>
        <span className="tabular-nums">· {props.turn.at}</span>
      </h3>
      <p className="text-sm leading-relaxed">{turnText(props.turn)}</p>
    </div>
  );
}

function SpeakerTurn(props: { turn: TurnFixture; speaker: ChatSpeaker; onTrace: OnTrace }) {
  const expression = turnIsWorking(props.turn) ? "thinking" : "idle";
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="flex items-center gap-2 text-xs text-muted-foreground">
        {props.speaker.agentId ? (
          <SupervisorAvatar
            agentId={props.speaker.agentId}
            size={TURN_AVATAR_SIZE}
            expression={expression}
          />
        ) : (
          <AssistantIcon size={TURN_AVATAR_SIZE} expression={expression} />
        )}
        <span className="text-sm font-medium text-foreground">{props.speaker.name}</span>
        <span className="tabular-nums">{props.turn.at}</span>
      </h3>
      {props.turn.blocks.filter(isShown).map((block) => {
        if (block.kind === "text") {
          return (
            <p key={blockKey(block)} className="text-sm leading-relaxed text-pretty">
              {block.text}
            </p>
          );
        }
        if (block.kind === "lookup")
          return <LookupRow key={blockKey(block)} lookup={block.lookup} />;
        if (block.kind === "notification") {
          return <NotificationRow key={blockKey(block)} notice={block} />;
        }
        if (block.kind === "automation") {
          return (
            <AutomationLink
              key={blockKey(block)}
              automationId={block.automationId}
              label={block.label}
            />
          );
        }
        const delegation = findDelegation(block.delegationId);
        return delegation ? (
          <DelegationCard
            key={blockKey(block)}
            delegation={delegation}
            fromNodeId={props.speaker.nodeId}
            onTrace={props.onTrace}
          />
        ) : null;
      })}
    </div>
  );
}

export function AssistantConversation(props: {
  chat: ChatFixture;
  speaker: ChatSpeaker;
  onTrace: OnTrace;
}) {
  return (
    <div className="flex flex-col gap-8">
      <CarriedOver chat={props.chat} onTrace={props.onTrace} />
      {props.chat.turns.map((turn) =>
        turn.role === "user" ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : turn.role === "handoff" ? (
          <HandoffTurn key={turn.id} turn={turn} />
        ) : isNotificationOnly(turn) ? (
          // A sent ping on its own needs no speaker header: one quiet line.
          turn.blocks.some(isShown) ? (
            <div key={turn.id} className="-my-4 flex flex-col">
              {turn.blocks
                .filter(isShown)
                .map((block) =>
                  block.kind === "notification" ? (
                    <NotificationRow key={blockKey(block)} notice={block} at={turn.at} />
                  ) : null,
                )}
            </div>
          ) : null
        ) : (
          <SpeakerTurn key={turn.id} turn={turn} speaker={props.speaker} onTrace={props.onTrace} />
        ),
      )}
    </div>
  );
}
