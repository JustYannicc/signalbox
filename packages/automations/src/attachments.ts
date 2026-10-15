import {
  ThreadId,
  type AutomationError,
  type AutomationRunAttach,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { Launch } from "./engineTypes.ts";
import { automationError, fail } from "./errors.ts";
import type { AutomationThreads, ThreadMonitor } from "./host.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import type { AutomationRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * Runs attached to a thread (`automation_run({ attach })`). While one runs,
 * the thread lists it as a monitor in its pending background work, so the
 * thread stays in Working like a pull request watch keeps it; the label is
 * the step it's waiting on, else the attachment's label. Settling, archiving
 * or deleting the thread, or Stop on it, cancels its attached runs.
 *
 * The monitors live in memory, rebuilt from the run links at startup, and
 * the host hears every change to a thread's (`monitorsChanged`), which it
 * shows in the thread's pending background work.
 */

/** `automation-run:<automationId>:<runId>`, so clients can open the run (see client-runtime's attached.ts). */
const TASK_PREFIX = "automation-run:";

/** Thread events that end the thread's attached runs. */
const ENDING_EVENTS: ReadonlySet<string> = new Set([
  "thread.settled",
  "thread.archived",
  "thread.deleted",
]);

export interface AttachmentDependencies {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly threads: AutomationThreads["Service"];
  /** Cancels a running run; false when it had already ended. */
  readonly cancel: (runId: string) => Effect.Effect<boolean, AutomationError>;
}

export const makeAttachments = (deps: AttachmentDependencies) => {
  const { store, links } = deps;
  /** threadId → runId → its automation and what the thread shows. */
  const monitors = new Map<
    string,
    Map<string, { readonly automationId: string; readonly label: string }>
  >();

  /** Tells the host what the thread lists now. */
  const publish = (threadId: string) =>
    deps.threads.monitorsChanged(
      threadId,
      [...(monitors.get(threadId) ?? [])].map(
        ([runId, { automationId, label }]): ThreadMonitor => ({
          taskId: `${TASK_PREFIX}${automationId}:${runId}`,
          description: label,
        }),
      ),
    );

  const drop = (threadId: string, runId: string) =>
    Effect.suspend(() => {
      const runs = monitors.get(threadId);
      if (!runs?.delete(runId)) return Effect.void;
      if (runs.size === 0) monitors.delete(threadId);
      return publish(threadId);
    });

  /** Brings a run's monitor up to date: shown while it runs, labelled by the step it waits on. */
  const refresh = (runId: string) =>
    Effect.gen(function* () {
      const link = yield* links.getLink(runId);
      if (!link?.thread_id) return;
      const run = yield* store.getRunMeta(runId);
      if (run?.status !== "running") return yield* drop(link.thread_id, runId);
      const waiting = (yield* store.listSteps(runId)).filter((step) => step.status === "waiting");
      const automation = yield* store.getAutomation(run.automation_id);
      const label =
        waiting.at(-1)?.label.trim() || link.label || automation?.name || "Automation running";
      const runs =
        monitors.get(link.thread_id) ??
        new Map<string, { readonly automationId: string; readonly label: string }>();
      if (runs.get(runId)?.label === label) return;
      runs.set(runId, { automationId: run.automation_id, label });
      monitors.set(link.thread_id, runs);
      yield* publish(link.thread_id);
    });

  /**
   * The launch fields for a run attached to `attach.threadId`: its link, and a
   * claim that returns the run already attached under the same key instead.
   * The thread has to be in the automation's project.
   */
  const launchFor = (automation: AutomationRow, attach: AutomationRunAttach) =>
    Effect.gen(function* () {
      const shell = yield* deps.threads
        .getThreadShell(ThreadId.make(attach.threadId))
        .pipe(Effect.mapError((cause) => automationError("Couldn't read the thread.", { cause })));
      if (shell === null || shell.deletedAt !== null)
        return yield* fail(`There's no thread ${attach.threadId} to attach to.`);
      if (shell.projectId !== automation.project_id)
        return yield* fail("A run can only attach to a thread in its automation's project.");
      const key = attach.key ?? automation.automation_id;
      return {
        link: {
          thread_id: attach.threadId,
          attach_key: key,
          label: attach.label ?? null,
          restart_of_run_id: null,
        },
        claim: () => links.runningAttached(attach.threadId, key),
      } satisfies Pick<Launch, "link" | "claim">;
    });

  /** Rebuilds the monitors after a restart. */
  const recover = Effect.gen(function* () {
    for (const link of yield* links.runningAttachedTo()) yield* refresh(link.run_id);
  });

  /** Cancels the runs attached to a thread; returns how many it stopped. */
  const cancelAttached = (threadId: string) =>
    Effect.gen(function* () {
      let cancelled = 0;
      for (const link of yield* links.runningAttachedTo(threadId)) {
        if (yield* deps.cancel(link.run_id)) cancelled++;
        yield* drop(threadId, link.run_id);
      }
      return cancelled;
    });

  /** Settling, archiving or deleting a thread ends what's attached to it. */
  const onDomainEvent = (event: OrchestrationV2DomainEvent) =>
    ENDING_EVENTS.has(event.type) && monitors.has(event.threadId)
      ? cancelAttached(event.threadId).pipe(Effect.asVoid)
      : Effect.void;

  /** What a thread's attached run shows, while it runs. */
  const shownOn = (threadId: string, runId: string) => monitors.get(threadId)?.get(runId)?.label;

  return { launchFor, refresh, recover, cancelAttached, onDomainEvent, shownOn };
};

export type Attachments = ReturnType<typeof makeAttachments>;
