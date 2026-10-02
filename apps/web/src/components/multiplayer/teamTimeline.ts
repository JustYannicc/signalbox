/**
 * Turns a team thread's messages into the real chat timeline's entries, so a
 * shared chat renders like any T3 thread: people's messages as user turns,
 * each agent turn as its work log (commands, edits, searches), answer and
 * plan, and system events (model switches, shares) as separator rows. The
 * side tables say who wrote each user turn and which harness answered.
 */
import { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage, ProposedPlan } from "../../types";
import { deriveTimelineEntries } from "../../session-logic";
import { mentionLabel, segmentMentions } from "./mentions";
import type { HarnessRef, SystemEvent, TeamMessage } from "./multiplayerModel";

/**
 * People, your assistant and your agents as the timeline's own inline
 * references (`t3-context://v1/<kind>/<id>`), so user bubbles can chip them.
 */
export function encodeMentions(body: string): string {
  return segmentMentions(body)
    .map((segment) => {
      const target = segment.mention;
      if (!target) return segment.text;
      const id =
        target.kind === "person"
          ? target.person.id
          : target.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      const label = `@${mentionLabel(target)}`.replace(/[[\]]/g, "");
      return `[${label}](t3-context://v1/${target.kind}/${id})`;
    })
    .join("");
}

const STEP_MS = 120_000;

export interface TeamTimeline {
  readonly entries: TimelineEntry[];
  /** User message id → person id. */
  readonly authors: ReadonlyMap<string, string>;
  /** Assistant message id → harness and whose message it answers. */
  readonly harnesses: ReadonlyMap<string, { harness: HarnessRef; forPersonId: string }>;
  /** Separator row id → system event, for its icon. */
  readonly events: ReadonlyMap<string, SystemEvent>;
  /** The agent turn still in progress, if the thread was caught mid-work. */
  readonly activeTurn: ActiveTeamTurn | null;
}

export interface ActiveTeamTurn {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly harness: HarnessRef;
  /** Who started it, and so who can answer its approval. */
  readonly forPersonId: string;
  readonly approval: TeamMessage["approval"] | null;
}

const DEFAULT_HARNESS: HarnessRef = { provider: "codex", model: "GPT-5.4" };

export function buildTeamTimeline(input: {
  threadId: string;
  messages: readonly TeamMessage[];
  /** When the last fixture message happened; earlier ones step back from it. */
  endsAt: string;
  /** Appended as a "Waiting for …" separator when the agent is holding its reply. */
  waitingLabel?: string | null;
}): TeamTimeline {
  const { threadId, messages } = input;
  const chatMessages: ChatMessage[] = [];
  const workEntries: WorkLogEntry[] = [];
  const plans: ProposedPlan[] = [];
  const authors = new Map<string, string>();
  const harnesses = new Map<string, { harness: HarnessRef; forPersonId: string }>();
  const events = new Map<string, SystemEvent>();
  let activeTurn: ActiveTeamTurn | null = null;
  const end = Date.parse(input.endsAt);
  const start = (Number.isNaN(end) ? Date.now() : end) - messages.length * STEP_MS;
  let clock = start;
  const nextTime = (message: TeamMessage, index: number) => {
    const planned = message.createdAt ? Date.parse(message.createdAt) : start + index * STEP_MS;
    clock = Math.max(clock + 1_000, planned);
    return clock;
  };

  messages.forEach((message, index) => {
    const previous = clock;
    const at = nextTime(message, index);
    const iso = new Date(at).toISOString();
    const key = `${threadId}:${message.id}`;
    const { author } = message;
    if (author.kind === "system") {
      workEntries.push({
        id: key,
        createdAt: iso,
        turnId: null,
        label: message.body,
        tone: "info",
        sourceActivityKind: "context-compaction",
      });
      events.set(key, author.event);
      return;
    }
    if (author.kind === "person") {
      authors.set(key, author.personId);
      chatMessages.push({
        id: MessageId.make(key),
        role: "user",
        text: encodeMentions(message.body),
        turnId: null,
        streaming: false,
        createdAt: iso,
        updatedAt: iso,
        ...(message.files && message.files.length > 0
          ? {
              attachments: message.files.map((name, fileIndex) => ({
                type: "file" as const,
                id: `${key}:file-${fileIndex}`,
                name,
                mimeType: "application/octet-stream",
                sizeBytes: 0,
                downloadable: false,
              })),
            }
          : {}),
      });
      return;
    }
    const turnId = TurnId.make(`${key}:turn`);
    const steps = message.work ?? [];
    const live = index === messages.length - 1 ? (message.live ?? null) : null;
    // The turn's reasoning and work sit between the message it answers and its
    // answer, so they never sort ahead of that message.
    const gap = Math.max(at - previous, 0) / (steps.length + 2);
    const turnStart = at - gap * (steps.length + 1);
    steps.forEach((step, stepIndex) => {
      const stepAt = new Date(turnStart + gap * (stepIndex + 1)).toISOString();
      workEntries.push({
        id: `${key}:work-${stepIndex}`,
        createdAt: stepAt,
        turnId,
        toolCallId: `${key}:call-${stepIndex}`,
        label: step.label,
        tone: step.failed ? "error" : "tool",
        ...(step.itemType ? { itemType: step.itemType } : {}),
        ...(step.command ? { command: step.command } : {}),
        ...(step.detail ? { detail: step.detail } : {}),
        ...(step.changedFiles ? { changedFiles: step.changedFiles } : {}),
        toolLifecycleStatus:
          step.running && live ? "inProgress" : step.failed ? "failed" : "completed",
      });
    });
    if (live) {
      activeTurn = {
        turnId,
        startedAt: new Date(turnStart).toISOString(),
        harness: author.harness ?? DEFAULT_HARNESS,
        forPersonId: author.startedById,
        approval: message.approval ?? null,
      };
    }
    if (live && message.reasoning) {
      chatMessages.push({
        id: MessageId.make(`${key}:reasoning`),
        role: "reasoning",
        text: message.reasoning,
        turnId,
        streaming: live === "thinking",
        createdAt: new Date(turnStart + gap / 2).toISOString(),
        updatedAt: iso,
      });
    }
    harnesses.set(key, {
      harness: author.harness ?? DEFAULT_HARNESS,
      forPersonId: author.startedById,
    });
    // Mid-thinking or mid-tool turns have no answer yet; nor does one that was
    // interrupted before answering.
    if (live === "thinking" || live === "working" || message.body.trim() === "") return;
    chatMessages.push({
      id: MessageId.make(key),
      role: "assistant",
      text: message.body,
      turnId,
      streaming: live === "answering",
      createdAt: iso,
      updatedAt: iso,
    });
    if (message.plan) {
      const planAt = new Date(at + 500).toISOString();
      plans.push({
        id: `${key}:plan`,
        turnId,
        planMarkdown: message.plan,
        implementedAt: null,
        implementationThreadId: null,
        createdAt: planAt,
        updatedAt: planAt,
      });
    }
  });

  if (input.waitingLabel) {
    const key = `${threadId}:waiting`;
    workEntries.push({
      id: key,
      createdAt: new Date(clock + 1_000).toISOString(),
      turnId: null,
      label: input.waitingLabel,
      tone: "info",
      sourceActivityKind: "context-compaction",
    });
    events.set(key, "waiting");
  }

  return {
    entries: deriveTimelineEntries(chatMessages, plans, workEntries),
    authors,
    harnesses,
    events,
    activeTurn,
  };
}
