import {
  AUTOMATION_RAW_EVENT_PREFIX,
  OrchestrationV2DomainEvent,
  type AutomationEventName,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  actorOf,
  cap,
  fixed,
  iso,
  RAW_STRING,
  SHORT_TEXT,
  TERMINAL_ITEMS,
  type Candidate,
} from "./candidate.ts";
import { itemCandidates } from "./turnItems.ts";
import { requestCandidates, runCandidates } from "./turns.ts";

export type { Actor, Candidate, EventReads } from "./candidate.ts";

/**
 * Turns orchestration domain events into the public events automations
 * trigger on. `candidatesFor` is synchronous and reads nothing, so events
 * nobody subscribes to cost a table lookup; `build` does the reads, only for
 * events someone wants. Every domain event also passes through raw as
 * `orchestration.<type>`, including types this table doesn't know yet.
 */

type DomainEvent = OrchestrationV2DomainEvent;
type EventOf<T extends DomainEvent["type"]> = DomainEvent extends infer D
  ? D extends { readonly type: infer K }
    ? T extends K
      ? D & { readonly type: T }
      : never
    : never
  : never;

/** Shortens every long string in a JSON value, for raw payloads. */
function capStrings(value: unknown): unknown {
  if (typeof value === "string") return cap(value, RAW_STRING);
  if (Array.isArray(value)) return value.map(capStrings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, capStrings(inner)]),
    );
  return value;
}

const encodeEvent = Schema.encodeUnknownSync(OrchestrationV2DomainEvent);
const rawCandidate = (event: DomainEvent): Candidate => ({
  name: `${AUTOMATION_RAW_EVENT_PREFIX}${event.type}`,
  id: event.id,
  build: () =>
    Effect.sync(() => ({
      type: event.type,
      data: capStrings((encodeEvent(event) as { readonly payload: unknown }).payload),
    })),
});

const threadFields = (thread: OrchestrationV2AppThread) => ({
  title: thread.title,
  provider: thread.providerInstanceId,
  model: thread.modelSelection.model,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  snoozedUntil: iso(thread.snoozedUntil),
});

/** Thread events whose payload is the thread itself, by public name. */
const THREAD_EVENTS = {
  "thread.archived": "thread.archived",
  "thread.unarchived": "thread.unarchived",
  "thread.deleted": "thread.deleted",
  "thread.settled": "thread.settled",
  "thread.unsettled": "thread.unsettled",
  "thread.snoozed": "thread.snoozed",
  "thread.unsnoozed": "thread.unsnoozed",
  "thread.pinned": "thread.pinned",
  "thread.unpinned": "thread.unpinned",
  "thread.metadata-updated": "thread.updated",
  "thread.model-selection-updated": "thread.model-changed",
  "thread.provider-switched": "thread.model-changed",
  "thread.runtime-mode-updated": "thread.mode-changed",
  "thread.interaction-mode-updated": "thread.mode-changed",
  "thread.pull-request-synced": "pr.updated",
} as const satisfies Partial<Record<DomainEvent["type"], AutomationEventName>>;

const pullRequestFields = (thread: OrchestrationV2AppThread) => ({
  pullRequests: (thread.pullRequests ?? [])
    .filter((link) => link.source !== "stack-dismissed")
    .map((link) => ({
      repository: link.repository,
      number: link.number,
      url: link.url,
      source: link.source,
    })),
  branchPullRequest: thread.branchPullRequest
    ? {
        repository: thread.branchPullRequest.repository,
        number: thread.branchPullRequest.number,
        url: thread.branchPullRequest.url,
      }
    : null,
});

type Mappers = {
  readonly [T in DomainEvent["type"]]?: (event: EventOf<T>) => ReadonlyArray<Candidate>;
};

const threadMapper =
  (name: AutomationEventName) =>
  (event: { readonly id: string; readonly payload: OrchestrationV2AppThread }): Candidate[] => [
    {
      name,
      id: event.id,
      projectId: event.payload.projectId,
      build: fixed(() => ({
        ...threadFields(event.payload),
        ...(name === "pr.updated" ? pullRequestFields(event.payload) : {}),
      })),
    },
  ];

const MAPPERS: Mappers = {
  ...(Object.fromEntries(
    Object.entries(THREAD_EVENTS).map(([type, name]) => [type, threadMapper(name)]),
  ) as Mappers),
  "thread.created": (event) => [
    {
      name: "thread.created",
      id: `thread.created:${event.payload.id}`,
      projectId: event.payload.projectId,
      actor: actorOf(event.payload.createdBy),
      build: fixed(() => ({
        ...threadFields(event.payload),
        createdBy: actorOf(event.payload.createdBy),
        parentThreadId: event.payload.lineage.parentThreadId,
      })),
    },
  ],
  "run.created": (event) => [
    {
      name: "turn.requested",
      id: `turn.requested:${event.payload.id}`,
      build: fixed(() => ({
        status: event.payload.status,
        userMessageId: event.payload.userMessageId,
      })),
    },
    ...runCandidates(event.payload),
  ],
  "run.updated": (event) => runCandidates(event.payload),
  "message.updated": (event) => {
    const message = event.payload;
    if (message.streaming || message.role === "system") return [];
    const automationMessage = message.id.startsWith("automation:");
    if (message.role === "assistant")
      return [
        {
          name: "agent.replied",
          id: `agent.replied:${message.id}`,
          build: fixed(() => ({ messageId: message.id, text: cap(message.text) })),
        },
      ];
    return [
      {
        name: "message.sent",
        id: `message.sent:${message.id}`,
        actor: actorOf(message.createdBy),
        automationMessage,
        build: fixed(() => ({
          messageId: message.id,
          text: cap(message.text),
          author: actorOf(message.createdBy),
          attachments: message.attachments.length,
        })),
      },
    ];
  },
  "runtime-request.updated": (event) => requestCandidates(event.threadId, event.payload),
  "turn-item.updated": (event) => itemCandidates(event.id, event.payload),
  "subagent.updated": (event) => {
    const task = event.payload;
    const base = {
      subagentId: task.id,
      origin: task.origin,
      title: task.title,
      childThreadId: task.childThreadId,
    };
    if (task.status === "running")
      return [
        {
          name: "subagent.started",
          id: `subagent.started:${task.id}`,
          build: fixed(() => ({
            ...base,
            prompt: cap(task.prompt, SHORT_TEXT),
            model: task.model,
          })),
        },
      ];
    if (!TERMINAL_ITEMS.has(task.status)) return [];
    return [
      {
        name: "subagent.finished",
        id: `subagent.finished:${task.id}`,
        build: fixed(() => ({ ...base, status: task.status, result: cap(task.result) })),
      },
    ];
  },
  "checkpoint.captured": (event) => [
    {
      name: "checkpoint.captured",
      id: `checkpoint.captured:${event.payload.id}`,
      build: fixed(() => ({
        checkpointId: event.payload.id,
        status: event.payload.status,
        files: event.payload.files,
      })),
    },
  ],
  "checkpoint.rollback-requested": (event) => [
    {
      name: "checkpoint.restore-requested",
      id: event.id,
      build: fixed(() => ({ checkpointId: event.payload.checkpointId })),
    },
  ],
};

/** The public events one domain event stands for: the friendly ones, then the raw one. */
export function candidatesFor(event: DomainEvent): ReadonlyArray<Candidate> {
  const mapper = MAPPERS[event.type] as
    | ((event: DomainEvent) => ReadonlyArray<Candidate>)
    | undefined;
  return [...(mapper?.(event) ?? []), rawCandidate(event)];
}

/** Public names the table can produce, so a test can hold it to the catalog. */
export const MAPPED_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(THREAD_EVENTS),
  "thread.created",
  "turn.requested",
  "turn.started",
  "turn.finished",
  "agent.replied",
  "message.sent",
  "input.requested",
  "input.resolved",
  "tool.started",
  "tool.called",
  "file.changed",
  "approval.requested",
  "question.asked",
  "plan.proposed",
  "todos.updated",
  "agent.error",
  "context.compacted",
  "subagent.started",
  "subagent.finished",
  "checkpoint.captured",
  "checkpoint.restore-requested",
] satisfies ReadonlyArray<AutomationEventName>);
