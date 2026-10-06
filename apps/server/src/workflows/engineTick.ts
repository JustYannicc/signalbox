import {
  automationAskTimeoutValue,
  CommandId,
  parseAutomationAsk,
  ProjectId,
  ThreadId,
  type AutomationError,
  type AutomationErrorDetail,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { automationTriggers, stepArgs } from "./columns.ts";
import type { EndRun, LaunchRun, Settlement } from "./engineTypes.ts";
import { asRecord } from "./json.ts";
import type { Change } from "./liveFeed.ts";
import { isModelVerb, modelResult } from "./modelSteps.ts";
import type { ReplayQueue } from "./replayQueue.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import type { RunLogs } from "./runLog.ts";
import type { makeRunFunction } from "./runFunction.ts";
import { describeDuration, retries, stepOptions, stepTimeoutMs } from "./stepPolicy.ts";
import { agentResult } from "./steps.ts";
import { isoAt } from "./time.ts";
import { nextRunAt } from "./views.ts";
import type { AutomationRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

/**
 * The engine's time-driven work, run by the scheduler's tick: due crons,
 * timers, timeouts, parked retries, a slow sweep of agent threads, and hourly
 * cleanup. Each item runs on its own, so one broken step or automation never
 * holds up the rest.
 */

/** A cron the server slept through longer than this is skipped, not caught up. */
const MISSED_CRON_WINDOW_MS = 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_KEEP = 50;
/**
 * Agent threads settle their steps from domain events as they finish. This
 * sweep (also the first tick after a start) catches any a restart or a
 * dropped event missed.
 */
const THREAD_SWEEP_INTERVAL_MS = 60 * 1000;

/** What the timed work needs from the engine's run core. */
export interface EngineCore {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly threads: ThreadManagementService["Service"];
  readonly services: Context.Context<ThreadManagementService>;
  readonly runFunction: Effect.Success<typeof makeRunFunction>;
  readonly runLogs: RunLogs;
  readonly changed: (change: Change) => Effect.Effect<void>;
  readonly runChanged: (runId: string, summary: boolean) => Effect.Effect<void, AutomationError>;
  readonly replays: ReplayQueue;
  readonly complete: (
    runId: string,
    key: string,
    outcome: Settlement,
  ) => Effect.Effect<boolean, AutomationError>;
  readonly retryOrFail: (
    step: StepRow,
    error: string,
    options?: { readonly detail?: AutomationErrorDetail | null },
  ) => Effect.Effect<boolean, AutomationError>;
  readonly execute: (automation: AutomationRow, step: StepRow) => Effect.Effect<void>;
  readonly endRun: EndRun;
  readonly launchRun: LaunchRun;
  readonly automationOfRun: (
    runId: string,
  ) => Effect.Effect<AutomationRow | undefined, AutomationError>;
  readonly ignoreFailure: (
    what: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A | void, never, R>;
}

const detail = (fix: string, why?: string): AutomationErrorDetail => ({
  why: why ?? null,
  fix,
  link: null,
});

export const makeTimedWork = (core: EngineCore) =>
  Effect.gen(function* () {
    const { store, threads, complete } = core;

    /**
     * Settles a thread-backed step whose thread finished. Model steps' threads
     * are settled out of the way, and a model answer that can't be read is
     * asked again while retries remain. False while the thread is still going.
     */
    const settleThreadStep = (step: StepRow) =>
      Effect.gen(function* () {
        if (step.thread_id === null) return false;
        const result = yield* agentResult(step.thread_id, step.agent_run_id).pipe(
          Effect.provideContext(core.services),
        );
        if (!result) return false;
        if (!isModelVerb(step.verb)) {
          yield* complete(step.run_id, step.step_key, result);
          return true;
        }
        const options = asRecord(stepArgs(step)[0]);
        const text = result.ok ? String((result.value as { text: unknown }).text) : "";
        const outcome = result.ok ? modelResult(step.verb, options, text) : result;
        yield* threads
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(
              `automation:${step.run_id}:${step.step_key}:settle${step.attempt > 1 ? `:${step.attempt}` : ""}`,
            ),
            threadId: ThreadId.make(step.thread_id),
          })
          .pipe(Effect.ignore);
        if (outcome.ok) yield* complete(step.run_id, step.step_key, outcome);
        else {
          const explanation = result.ok
            ? detail(
                "Make the question or the shape clearer, or allow more tries: { retry: { attempts: 3 } }.",
                "The model's answer didn't match what the step asked for.",
              )
            : "detail" in result
              ? result.detail
              : null;
          yield* core.retryOrFail(step, outcome.error, { detail: explanation });
        }
        return true;
      });

    /** An agent or model step whose thread ran past its timeout: stop the thread and fail the step. */
    const timeOutThreadStep = (step: StepRow) =>
      Effect.gen(function* () {
        const automation = yield* core.automationOfRun(step.run_id);
        if (automation && step.thread_id !== null) {
          yield* threads
            .interruptThread({
              projectId: ProjectId.make(automation.project_id),
              commandId: CommandId.make(
                `automation:${step.run_id}:${step.step_key}:timeout:${step.attempt}`,
              ),
              threadId: ThreadId.make(step.thread_id),
              reason: "The automation step timed out.",
            })
            .pipe(Effect.ignore);
        }
        const limit = stepTimeoutMs(step.verb, stepArgs(step));
        const who = step.verb === "agent" ? "agent" : "model";
        yield* complete(step.run_id, step.step_key, {
          ok: false,
          error: `The ${who} didn't finish within ${limit === null ? "its time limit" : describeDuration(limit)}.`,
          detail: detail(
            "Give the step more time, e.g. { timeout: { hours: 4 } }, or ask for less.",
          ),
        });
      });

    /** An `ask` nobody answered in time: its `onTimeout` option, else a failure. */
    const timeOutAsk = (step: StepRow) => {
      const fallback = automationAskTimeoutValue(
        parseAutomationAsk(stepOptions("ask", stepArgs(step))).ask,
      );
      return complete(
        step.run_id,
        step.step_key,
        fallback
          ? { ok: true, value: fallback.value }
          : {
              ok: false,
              error: "Nobody answered in time.",
              detail: detail(
                'Give it onTimeout: "<option>" to go on without an answer, or a longer timeout.',
              ),
            },
      );
    };

    /** Starts the next attempt of a step parked for a retry. */
    const retryStep = (step: StepRow) =>
      Effect.gen(function* () {
        const restarted = yield* store.restartStep(step.run_id, step.step_key, step.attempt);
        if (!restarted) return;
        const automation = yield* core.automationOfRun(step.run_id);
        if (!automation) return;
        yield* core.runChanged(step.run_id, false);
        yield* core.execute(automation, restarted);
      });

    /** A waiting step whose timer, timeout or retry is due. */
    const wakeStep = (step: StepRow) =>
      Effect.gen(function* () {
        if (step.thread_id !== null) {
          if (!(yield* settleThreadStep(step))) yield* timeOutThreadStep(step);
          return;
        }
        if (retries(step.verb)) return yield* retryStep(step);
        if (step.verb === "ask") return yield* timeOutAsk(step);
        yield* complete(step.run_id, step.step_key, { ok: true, value: null });
      });

    /** Fails a run past its `meta.timeout`. */
    const timeOutRun = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* store.getRun(runId);
        if (!run?.deadline_at) return;
        const limit =
          DateTime.makeUnsafe(run.deadline_at).epochMilliseconds -
          DateTime.makeUnsafe(run.started_at).epochMilliseconds;
        yield* core.endRun(run, {
          status: "failed",
          error: `The run didn't finish within its ${describeDuration(limit)} timeout.`,
          detail: detail("Raise meta.timeout, or split the work into smaller runs."),
        });
      });

    /** Starts a due cron run, unless it was missed long ago or the last run is still going. */
    const fireCron = (automation: AutomationRow, now: DateTime.Utc) =>
      Effect.gen(function* () {
        const due = automation.next_run_at;
        if (due === null) return;
        // Guarded: a pause or another tick since the read wins, and nothing re-enables it.
        const claimed = yield* store.claimSchedule(
          automation.automation_id,
          due,
          nextRunAt(automationTriggers(automation), true, now),
        );
        if (!claimed) return;
        yield* core.changed({ kind: "automation", automationId: automation.automation_id });
        const missed =
          DateTime.makeUnsafe(due).epochMilliseconds <
          now.epochMilliseconds - MISSED_CRON_WINDOW_MS;
        if (missed) return;
        const overlapping =
          automation.overlap !== "allow" &&
          (yield* store.runningRunsOf(automation.automation_id)).length > 0;
        if (overlapping) return;
        yield* core.launchRun({ automation, input: null, trigger: "cron" });
      });

    /** Old finished runs, stale webhook ids, and installed versions nothing uses anymore. */
    const prune = (now: DateTime.Utc) =>
      Effect.gen(function* () {
        const lostRuns = yield* store.withTransaction(
          store.prune({
            before: isoAt(now.epochMilliseconds - RETENTION_AGE_MS),
            keep: RETENTION_KEEP,
            now,
          }),
        );
        for (const automationId of lostRuns)
          yield* core.changed({ kind: "runs", automationId, summary: true });
        const runningRuns = yield* store.runningRuns();
        yield* core.runLogs.sweep(new Set(runningRuns.map((run) => run.run_id)));
        yield* core.links.prune();
        const running = Map.groupBy(runningRuns, (run) => run.automation_id);
        for (const automation of yield* store.listAutomations()) {
          const keep = new Set([
            automation.version,
            ...(running.get(automation.automation_id) ?? []).map((run) => run.version),
          ]);
          yield* core.runFunction
            .prune(automation.automation_id, keep)
            .pipe(core.ignoreFailure("old versions couldn't be deleted"));
        }
      });

    let lastPrune = Number.NEGATIVE_INFINITY;
    let lastThreadSweep = Number.NEGATIVE_INFINITY;
    // The scheduler and callers may tick at once; one at a time keeps each item handled once.
    const tickLock = yield* Semaphore.make(1);
    const tick: Effect.Effect<void, AutomationError> = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowText = DateTime.formatIso(now);
      for (const automation of yield* store.dueAutomations(nowText)) {
        yield* fireCron(automation, now).pipe(core.ignoreFailure("cron"));
      }
      for (const step of yield* store.dueSteps(nowText)) {
        yield* wakeStep(step).pipe(core.ignoreFailure("waiting step"));
      }
      if (now.epochMilliseconds - lastThreadSweep >= THREAD_SWEEP_INTERVAL_MS) {
        lastThreadSweep = now.epochMilliseconds;
        for (const step of yield* store.threadSteps()) {
          yield* settleThreadStep(step).pipe(core.ignoreFailure("agent step"));
        }
      }
      for (const runId of yield* store.overdueRuns(nowText)) {
        yield* timeOutRun(runId).pipe(core.ignoreFailure("run timeout"));
      }
      yield* core.replays.retryDue(now.epochMilliseconds);
      if (now.epochMilliseconds - lastPrune >= RETENTION_INTERVAL_MS) {
        lastPrune = now.epochMilliseconds;
        yield* prune(now).pipe(core.ignoreFailure("cleanup"));
      }
    }).pipe(tickLock.withPermits(1));

    return { settleThreadStep, tick };
  });
