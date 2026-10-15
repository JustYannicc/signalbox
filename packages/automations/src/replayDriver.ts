import {
  workflowNodeIdForStepKey,
  type AutomationErrorDetail,
  type AutomationRunLog,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { errorDetailOf, stepArgs } from "./columns.ts";
import { makeTimedWork } from "./engineTick.ts";
import { automationError, causeText, isAutomationError } from "./errors.ts";
import { forkRoot } from "./host.ts";
import { fromJson, toJson } from "./json.ts";
import { makeReplayQueue } from "./replayQueue.ts";
import { makeInheritance } from "./retry.ts";
import type { EngineInternals, RunDriver } from "./runDriver.ts";
import { errorDetail } from "./runLog.ts";
import { replayWorkflow, type JournalResult } from "./sandbox/replayWorkflow.ts";
import type { StepOutcome } from "./startStep.ts";
import { retryDelayMs, retryPolicy, transientCause } from "./stepPolicy.ts";
import { afterMs } from "./steps.ts";
import { isoAt, nowIso } from "./time.ts";
import type { AutomationRow, StepRow } from "./WorkflowStore.ts";

/**
 * The server's run core: each run replays from the top in QuickJS after
 * every step that finishes (see docs/internals/automations.md). Steps run in
 * fibers the run owns; the scheduler's tick drives timers, timeouts and
 * parked retries.
 */

const REPLAY_MISMATCH: AutomationErrorDetail = {
  why: "A step's label came out different on replay, usually because it's built from data that changed between replays.",
  fix: "Build step labels from the input and step results only, then run the automation again.",
  link: null,
};

export const makeReplayDriver = (core: EngineInternals) =>
  Effect.gen(function* () {
    const { store, runLogs, runWaits, attachments, complete, endRun, endRunById } = core;
    const replays = yield* makeReplayQueue;

    /** Step fibers per run, so ending a run interrupts its requests and processes. */
    const inflight = new Map<string, Set<Fiber.Fiber<unknown, unknown>>>();
    const interruptSteps = (runId: string) =>
      Effect.withFiber((current) => {
        const fibers = [...(inflight.get(runId) ?? [])].filter((fiber) => fiber !== current);
        inflight.delete(runId);
        return Effect.forEach(fibers, Fiber.interrupt, { discard: true });
      });

    /**
     * Parks a failed attempt until its backoff ends, or fails the step when its
     * retries are used up. The attempt count is journaled, so a restart neither
     * loses nor repeats a retry.
     */
    const retryOrFail = (
      step: StepRow,
      error: string,
      options: {
        readonly retryAfterMs?: number | undefined;
        readonly detail?: AutomationErrorDetail | null;
      } = {},
    ) =>
      Effect.gen(function* () {
        const policy = retryPolicy(step.verb, stepArgs(step));
        const detail = options.detail ?? null;
        if (step.attempt >= policy.attempts)
          return yield* complete(step.run_id, step.step_key, { ok: false, error, detail });
        const wakeAt = yield* afterMs(retryDelayMs(policy, step.attempt, options.retryAfterMs));
        const parked = yield* store.scheduleRetry(
          step.run_id,
          step.step_key,
          step.attempt,
          wakeAt,
          error,
        );
        if (parked) {
          yield* runLogs.step(step, { status: "retrying", error, detail });
          yield* core.runChanged(step.run_id, false);
        }
        return false;
      });

    /** Runs a step the code just reached, in a fiber the run owns. Waiting steps finish later from outside. */
    const execute = (automation: AutomationRow, step: StepRow) => {
      const work = runLogs.step(step, { status: "running" }).pipe(
        Effect.andThen(core.startStep(automation, step)),
        Effect.flatMap((start: StepOutcome) => {
          switch (start.type) {
            case "done":
              return complete(step.run_id, step.step_key, { ok: true, value: start.value });
            case "retry":
              return retryOrFail(step, start.error, { retryAfterMs: start.retryAfterMs });
            case "waiting":
              return store.markWaiting(step.run_id, step.step_key, start).pipe(
                Effect.tap((moved) =>
                  moved
                    ? runLogs.step(step, { status: "waiting" }).pipe(
                        Effect.andThen(core.runChanged(step.run_id, step.verb === "ask")),
                        // An event may have arrived before the step started waiting. A computed
                        // `on` starts listening only now, so the listeners are rebuilt first.
                        Effect.andThen(
                          step.verb === "waitFor"
                            ? runWaits
                                .stepWaiting(step)
                                .pipe(Effect.andThen(runWaits.deliverPending(step.run_id)))
                            : Effect.void,
                        ),
                        Effect.andThen(attachments.refresh(step.run_id)),
                      )
                    : Effect.void,
                ),
              );
          }
        }),
        // Only the call that moved the step tells the user, so restarts and replays can't repeat it.
        Effect.tap((moved) => (moved ? core.announce(automation, step) : Effect.void)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          const detail = errorDetail(error);
          const transient = isAutomationError(error) ? transientCause(error) : undefined;
          return transient
            ? retryOrFail(step, causeText(cause), { retryAfterMs: transient.retryAfterMs, detail })
            : complete(step.run_id, step.step_key, { ok: false, error: causeText(cause), detail });
        }),
        core.ignoreFailure("step couldn't be recorded"),
      );
      const tracked = Effect.withFiber((fiber) => {
        const fibers = inflight.get(step.run_id) ?? new Set();
        inflight.set(step.run_id, fibers);
        fibers.add(fiber);
        return work.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              fibers.delete(fiber);
              if (fibers.size === 0 && inflight.get(step.run_id) === fibers)
                inflight.delete(step.run_id);
            }),
          ),
        );
      });
      return replays
        .adjustBusy(1)
        .pipe(
          Effect.andThen(
            tracked.pipe(Effect.ensuring(replays.adjustBusy(-1)), Effect.forkIn(core.scope)),
          ),
          Effect.asVoid,
        );
    };

    /** Replays a run from its journal and acts on where it got to. */
    const advance = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* store.getRun(runId);
        if (!run || run.status !== "running") return;
        const automation = yield* store.getAutomation(run.automation_id);
        const script = yield* store.getVersionScript(run.automation_id, run.version);
        if (!automation || script === undefined)
          return yield* endRun(run, {
            status: "failed",
            error: "The automation behind this run is gone.",
            detail: {
              why: "The automation or the version this run started on was deleted.",
              fix: null,
              link: null,
            },
          });
        const steps = new Map((yield* store.listSteps(runId)).map((step) => [step.step_key, step]));
        const inherited =
          run.retry_of_run_id !== null && steps.size === 0
            ? makeInheritance(yield* store.listSteps(run.retry_of_run_id), runId)
            : undefined;
        let mismatch: string | null = null;
        const outcome = yield* Effect.tryPromise({
          try: () =>
            replayWorkflow({
              script,
              input: fromJson(run.input_json),
              trigger: fromJson(run.trigger_json) ?? { type: run.trigger },
              startedAt: DateTime.makeUnsafe(run.replay_started_at ?? run.started_at)
                .epochMilliseconds,
              seed: run.replay_seed ?? runId,
              result: ({ key, verb, label }): JournalResult | undefined => {
                const step = steps.get(key) ?? inherited?.take({ key, verb, label });
                if (!step) return undefined;
                if (step.verb !== verb || step.label !== label) {
                  mismatch ??= `Step ${key} was "${step.label}" before and is "${label}" now; the code didn't replay the same way.`;
                }
                const at = step.finished_at
                  ? DateTime.makeUnsafe(step.finished_at).epochMilliseconds
                  : 0;
                if (step.status === "succeeded")
                  return { ok: true, value: fromJson(step.result_json), at };
                if (step.status === "failed")
                  return { ok: false, error: step.error ?? "The step failed.", at };
                return undefined;
              },
            }),
          catch: (cause) => automationError("The automation sandbox failed.", { runId, cause }),
        });
        const reused = inherited?.reused() ?? [];
        for (const copy of reused) {
          yield* store.insertStep(copy);
          steps.set(copy.step_key, copy);
        }
        const marks = toJson(Object.fromEntries(outcome.marks));
        const logs = toJson(
          outcome.logs.map((entry): AutomationRunLog => ({ ...entry, at: isoAt(entry.at) })),
        );
        // Most replays end where the last one did; only a changed run is written and announced.
        const replayed = marks !== run.marks_json || logs !== run.logs_json;
        if (replayed) yield* store.saveReplay(runId, marks, logs);
        const current = { ...run, marks_json: marks, logs_json: logs };
        if (mismatch)
          return yield* endRun(current, {
            status: "failed",
            error: mismatch,
            detail: REPLAY_MISMATCH,
          });
        if (outcome.type === "completed")
          return yield* endRun(current, { status: "succeeded", output: outcome.output });
        if (outcome.type === "restart")
          return yield* core.restart(current, automation, outcome.input);
        if (outcome.type === "failed") {
          // A step failure nothing caught surfaces with the step's message; keep its explanation.
          const cause = [...steps.values()].find(
            (step) => step.status === "failed" && step.error === outcome.error,
          );
          return yield* endRun(current, {
            status: "failed",
            error: outcome.error,
            detail: errorDetailOf(cause?.error_detail_json ?? null),
          });
        }

        // A cancel or timeout may have ended the run while the sandbox ran; start nothing new then.
        if ((yield* store.getRunMeta(runId))?.status !== "running") return;
        const now = yield* nowIso;
        const fresh = outcome.requests.filter((request) => !steps.has(request.key));
        for (const request of fresh) {
          const row: StepRow = {
            run_id: runId,
            step_key: request.key,
            node_id: workflowNodeIdForStepKey(request.key),
            verb: request.verb,
            label: request.label,
            status: "running",
            args_json: toJson(request.args),
            result_json: null,
            error: null,
            error_detail_json: null,
            thread_id: null,
            wake_at: null,
            event: null,
            attempt: 1,
            started_at: now,
            finished_at: null,
          };
          if (yield* store.insertStep(row)) yield* execute(automation, row);
        }
        const pending = [...steps.values()].some(
          (step) => step.status === "running" || step.status === "waiting",
        );
        if (fresh.length === 0 && !pending) {
          return yield* endRun(current, {
            status: "failed",
            error: "The automation is waiting on something that will never finish.",
            detail: {
              why: "The code awaits a promise that no step will ever settle.",
              fix: "Await only steps and values built from them; don't await promises the code makes itself.",
              link: null,
            },
          });
        }
        if (replayed || fresh.length > 0 || reused.length > 0)
          yield* core.changed({
            kind: "runs",
            automationId: run.automation_id,
            runId,
            summary: false,
          });
      });

    const timed = yield* makeTimedWork({
      ...core,
      replays,
      retryOrFail,
      execute,
    });

    // Replays that fail outside the code (storage, sandbox) are retried by the tick with
    // backoff, and only fail the run once retries run out.
    yield* replays.start((runId) =>
      advance(runId).pipe(
        Effect.andThen(replays.forget(runId)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const { retry, failures } = yield* replays.failed(runId, now.epochMilliseconds);
            yield* Effect.logWarning("Automation run couldn't advance", { runId, failures, cause });
            if (!retry) yield* endRunById(runId, { status: "failed", error: causeText(cause) });
          }).pipe(Effect.ignore),
        ),
      ),
    );

    // Startup recovery: restart steps a restart cut off, then replay running runs.
    yield* forkRoot(
      Effect.gen(function* () {
        for (const step of yield* store.stepsWithStatus("running")) {
          const automation = yield* core.automationOfRun(step.run_id);
          if (automation) yield* execute(automation, step);
        }
        for (const { run_id } of yield* store.runningRuns()) yield* replays.enqueue(run_id);
      }).pipe(core.ignoreFailure("recovery")),
    );

    return {
      settled: (runId) => replays.enqueue(runId),
      launched: (runId) => replays.enqueue(runId),
      ended: (runId) => replays.forget(runId).pipe(Effect.andThen(interruptSteps(runId))),
      settleThreadStep: timed.settleThreadStep,
      tick: timed.tick,
      adjustBusy: replays.adjustBusy,
      drain: replays.drain,
    } satisfies RunDriver;
  });
