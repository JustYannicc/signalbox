import {
  ThreadId,
  type AutomationError,
  type AutomationRunAttach,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import {
  setThreadMonitorSource,
  type PendingBackgroundWorkTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";

import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { Launch } from "./engineTypes.ts";
import { automationError, fail } from "./errors.ts";
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
 * reach thread shells through upstream's pending-work function (see
 * `setThreadMonitorSource`). A shell picks a change up the next time the
 * thread's shell is read: the turn that attached the run ending, the agent
 * being woken, the thread settling.
 */

const TASK_PREFIX = "automation-run:";

/** Whether a pending task is an attached automation run, for clients that show their own. */
const isAttachedRunTask = (task: Pick<PendingBackgroundWorkTask, "taskId">) =>
  task.taskId.startsWith(TASK_PREFIX);

/** Thread events that end the thread's attached runs. */
const ENDING_EVENTS: ReadonlySet<string> = new Set([
  "thread.settled",
  "thread.archived",
  "thread.deleted",
]);

export interface AttachmentDependencies {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly threads: ThreadManagementService["Service"];
  /** Cancels a running run; false when it had already ended. */
  readonly cancel: (runId: string) => Effect.Effect<boolean, AutomationError>;
}

export const makeAttachments = (deps: AttachmentDependencies) => {
  const { store, links } = deps;
  /** threadId → runId → what the thread shows. */
  const monitors = new Map<string, Map<string, string>>();

  setThreadMonitorSource((threadId) =>
    [...(monitors.get(threadId) ?? [])].map(([runId, description]) => ({
      taskId: `${TASK_PREFIX}${runId}`,
      kind: "monitor" as const,
      description,
    })),
  );

  const drop = (threadId: string, runId: string) => {
    const runs = monitors.get(threadId);
    runs?.delete(runId);
    if (runs?.size === 0) monitors.delete(threadId);
  };

  /** Brings a run's monitor up to date: shown while it runs, labelled by the step it waits on. */
  const refresh = (runId: string) =>
    Effect.gen(function* () {
      const link = yield* links.getLink(runId);
      if (!link?.thread_id) return;
      const run = yield* store.getRunMeta(runId);
      if (run?.status !== "running") return drop(link.thread_id, runId);
      const waiting = (yield* store.listSteps(runId)).filter((step) => step.status === "waiting");
      const automation = yield* store.getAutomation(run.automation_id);
      const label =
        waiting.at(-1)?.label.trim() || link.label || automation?.name || "Automation running";
      const runs = monitors.get(link.thread_id) ?? new Map<string, string>();
      runs.set(runId, label);
      monitors.set(link.thread_id, runs);
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
        drop(threadId, link.run_id);
      }
      return cancelled;
    });

  /** Settling, archiving or deleting a thread ends what's attached to it. */
  const onDomainEvent = (event: OrchestrationV2DomainEvent) =>
    ENDING_EVENTS.has(event.type) && monitors.has(event.threadId)
      ? cancelAttached(event.threadId).pipe(Effect.asVoid)
      : Effect.void;

  return { launchFor, refresh, recover, cancelAttached, onDomainEvent };
};

export type Attachments = ReturnType<typeof makeAttachments>;
