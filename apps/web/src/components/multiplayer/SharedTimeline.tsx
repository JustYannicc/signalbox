/**
 * A shared chat rendered by the real `MessagesTimeline`: work logs, tool
 * calls, answers and plans exactly as in a solo thread. Annotations add what
 * multiplayer needs: who wrote each human turn (right, with their avatar),
 * which harness answered (left, with its lab avatar), people as @mention
 * chips, and icons for system events.
 */
import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowLeftRightIcon,
  BellIcon,
  HourglassIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useRef } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { TimelineAnnotationsContext, type TimelineAnnotations } from "../chat/timelineAnnotations";
import { MessageMentionPill } from "./MentionPill";
import type { SystemEvent } from "./multiplayerModel";
import { useAssistantDirectory } from "./personAssistant";
import { HarnessMessageHeader, PersonMessageHeader } from "./TimelineHeaders";
import type { TeamTimeline } from "./teamTimeline";
import { currentPerson, findPerson } from "./teamThreads";

const PREVIEW_ENVIRONMENT_ID = EnvironmentId.make("multiplayer-preview");
const noop = () => {};

function EventIcon(props: { event: SystemEvent }) {
  const Icon =
    props.event === "share"
      ? UsersIcon
      : props.event === "kind"
        ? ListTodoIcon
        : props.event === "waiting"
          ? HourglassIcon
          : props.event === "mode"
            ? MessagesSquareIcon
            : props.event === "notify"
              ? BellIcon
              : ArrowLeftRightIcon;
  return <Icon aria-hidden className="size-3" />;
}

function useAnnotations(timeline: TeamTimeline): TimelineAnnotations {
  const ownAssistantName = useAssistantDirectory()(currentPerson).name;
  return useMemo(
    () => ({
      userMessageHeader: (messageId) => {
        const person = findPerson(timeline.authors.get(messageId) ?? "");
        return person ? <PersonMessageHeader person={person} /> : null;
      },
      assistantMessageHeader: (messageId) => {
        const answer = timeline.harnesses.get(messageId);
        return answer ? (
          <HarnessMessageHeader provider={answer.harness.provider} model={answer.harness.model} />
        ) : null;
      },
      renderContextReference: (reference) => {
        const name = reference.label.replace(/^@/, "");
        if (reference.kind === "person") {
          const person = findPerson(reference.contextId);
          return person ? <MessageMentionPill target={{ kind: "person", person }} /> : null;
        }
        if (reference.kind === "assistant") {
          return <MessageMentionPill target={{ kind: "assistant", name: ownAssistantName }} />;
        }
        return reference.kind === "agent" ? (
          <MessageMentionPill target={{ kind: "agent", name }} />
        ) : null;
      },
      separatorIcon: (rowId) => {
        const event = timeline.events.get(rowId);
        return event ? <EventIcon event={event} /> : undefined;
      },
    }),
    [ownAssistantName, timeline],
  );
}

export function SharedTimeline(props: { threadKey: string; timeline: TeamTimeline }) {
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const environmentId = usePrimaryEnvironmentId() ?? PREVIEW_ENVIRONMENT_ID;
  const annotations = useAnnotations(props.timeline);
  // A thread caught mid-work drives the real live rows: Working for…, running
  // tools, streaming reasoning and answers.
  const active = props.timeline.activeTurn;
  return (
    <TimelineAnnotationsContext value={annotations}>
      <MessagesTimeline
        isWorking={active !== null}
        activeTurnStartedAt={active?.startedAt ?? null}
        listRef={listRef}
        timelineEntries={props.timeline.entries}
        latestTurn={
          active
            ? {
                turnId: active.turnId,
                state: "running",
                startedAt: active.startedAt,
                completedAt: null,
              }
            : null
        }
        runningTurnId={active?.turnId ?? null}
        turnDiffSummaries={[]}
        routeThreadKey={`shared:${props.threadKey}`}
        onOpenTurnDiff={noop}
        supportsConversationRollback={false}
        onRevertToTurnCount={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        activeThreadEnvironmentId={environmentId}
        markdownCwd={undefined}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={undefined}
        anchorMessageId={null}
        onAnchorReady={noop}
        contentInsetEndAdjustment={0}
        liveFollowEnabled
        onIsAtEndChange={noop}
        onManualNavigation={noop}
      />
    </TimelineAnnotationsContext>
  );
}
