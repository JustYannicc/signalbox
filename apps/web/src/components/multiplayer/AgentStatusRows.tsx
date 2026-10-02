/**
 * Live rows under a shared chat's timeline: the agent holding its answer
 * ("Codex is waiting for Samir", with Reply now / Stop waiting), and who is
 * typing (with their avatar). Plus the composer banner for an approval the
 * running turn is waiting on: yours to answer with the real approval
 * actions, or someone else's to wait for.
 */
import { ApprovalRequestId } from "@t3tools/contracts";
import { ShieldAlertIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { HarnessAvatar } from "../chat/HarnessAvatar";
import { Button } from "../ui/button";
import { firstName, type HarnessRef, type TeamPerson } from "./multiplayerModel";
import { PersonAvatar } from "./PersonAvatar";
import { joinNames } from "./sharing";
import type { ActiveTeamTurn } from "./teamTimeline";
import { currentPerson, findPerson } from "./teamThreads";

export const HARNESS_NAME: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
};

export function AgentWaitingRow(props: {
  harness: HarnessRef;
  waitingFor: readonly TeamPerson[];
  onReplyNow: () => void;
  /** Omitted when the wait comes from the chat's reply mode, not a set wait. */
  onStopWaiting?: (() => void) | undefined;
}) {
  const name = HARNESS_NAME[props.harness.provider] ?? props.harness.provider;
  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-(--chat-max-width) flex-wrap items-center gap-2 px-4 py-2 text-sm"
    >
      <HarnessAvatar provider={props.harness.provider} size={20} expression="listening" />
      <span className="text-muted-foreground">
        {name} is waiting for {joinNames(props.waitingFor, "them")}
      </span>
      <span className="flex -space-x-1">
        {props.waitingFor.map((person) => (
          <PersonAvatar
            key={person.id}
            person={person}
            size="sm"
            ringClassName="ring-2 ring-background"
          />
        ))}
      </span>
      <span className="ms-auto flex items-center gap-1">
        <Button size="xs" variant="outline" onClick={props.onReplyNow}>
          Reply now
        </Button>
        {props.onStopWaiting ? (
          <Button size="xs" variant="ghost" onClick={props.onStopWaiting}>
            Stop waiting
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function TypingRow(props: { person: TeamPerson }) {
  return (
    <p
      aria-live="polite"
      className="mx-auto flex w-full max-w-(--chat-max-width) items-center gap-2 px-4 pb-1 text-xs text-muted-foreground"
    >
      <PersonAvatar person={props.person} size="sm" />
      {firstName(props.person.name)} is typing…
    </p>
  );
}

/** The approval banner for a running turn, or `null` when none is pending. */
export function approvalBanner(input: {
  threadId: string;
  turn: ActiveTeamTurn | null;
  onDecide: (decision: string) => void;
}): ComposerBannerStackItem | null {
  const approval = input.turn?.approval;
  if (!input.turn || !approval) return null;
  const starter = findPerson(input.turn.forPersonId);
  const yours = input.turn.forPersonId === currentPerson.id;
  const title = approval.kind === "command" ? "Command approval" : "File change approval";
  return {
    id: "turn-approval",
    variant: "warning",
    priority: "urgent",
    icon: <ShieldAlertIcon />,
    title: yours ? title : `Waiting for ${starter ? firstName(starter.name) : "them"} to approve`,
    description: <code className="font-mono text-xs">{approval.detail}</code>,
    ...(yours
      ? {
          actions: (
            <ComposerPendingApprovalActions
              requestId={ApprovalRequestId.make(`${input.threadId}:approval`)}
              isResponding={false}
              onRespondToApproval={(_requestId, decision) => {
                input.onDecide(decision);
                return Promise.resolve();
              }}
            />
          ),
        }
      : {}),
  };
}
