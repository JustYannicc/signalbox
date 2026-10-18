import { expect, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DONE_CONDITION_KEY, makeAttachments } from "./attachments.ts";
import type { AutomationThreads } from "./host.ts";
import type { RunLinkRow, RunLinkStore } from "./runLinkStore.ts";
import type { WorkflowStore } from "./WorkflowStore.ts";

it.effect("cancels a persisted attachment when settlement arrives before monitor recovery", () => {
  const threadId = "thread-1";
  const link: RunLinkRow = {
    run_id: "run-1",
    thread_id: threadId,
    attach_key: "watch",
    label: "Waiting for CI",
    restart_of_run_id: null,
    lineage_id: "run-1",
    started_at: "2026-10-17T10:00:00.000Z",
    event_patterns_json: "[]",
  };
  const lookups: Array<string | undefined> = [];
  const cancelled: string[] = [];
  const attachments = makeAttachments({
    store: {} as WorkflowStore,
    links: {
      runningAttachedTo: (forThread: string | undefined) => {
        lookups.push(forThread);
        return Effect.succeed([link]);
      },
    } as unknown as RunLinkStore,
    threads: { monitorsChanged: () => Effect.void } as unknown as AutomationThreads["Service"],
    cancel: (runId) =>
      Effect.sync(() => {
        cancelled.push(runId);
        return true;
      }),
  });

  return Effect.gen(function* () {
    expect(attachments.shownOn(threadId, link.run_id)).toBeUndefined();
    yield* attachments.onDomainEvent({
      id: "event-1",
      type: "thread.settled",
      threadId,
    } as unknown as OrchestrationV2DomainEvent);

    expect(lookups).toEqual([threadId]);
    expect(cancelled).toEqual([link.run_id]);
  });
});

it.effect("leaves a task's done-condition run to the task lifecycle when the task settles", () => {
  const threadId = "thread-1";
  const link = (runId: string, key: string): RunLinkRow => ({
    run_id: runId,
    thread_id: threadId,
    attach_key: key,
    label: null,
    restart_of_run_id: null,
    lineage_id: runId,
    started_at: "2026-10-17T10:00:00.000Z",
    event_patterns_json: "[]",
  });
  const cancelled: string[] = [];
  const attachments = makeAttachments({
    store: {} as WorkflowStore,
    links: {
      runningAttachedTo: () =>
        Effect.succeed([link("run-watch", "watch"), link("run-done", DONE_CONDITION_KEY)]),
    } as unknown as RunLinkStore,
    threads: { monitorsChanged: () => Effect.void } as unknown as AutomationThreads["Service"],
    cancel: (runId) =>
      Effect.sync(() => {
        cancelled.push(runId);
        return true;
      }),
  });

  return Effect.gen(function* () {
    yield* attachments.onDomainEvent({
      id: "event-1",
      type: "thread.settled",
      threadId,
    } as unknown as OrchestrationV2DomainEvent);
    expect(cancelled).toEqual(["run-watch"]);
  });
});
