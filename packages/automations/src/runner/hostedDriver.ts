import {
  AutomationError,
  workflowNodeIdForStepKey,
  type AutomationErrorDetail,
  type WorkflowStepVerb,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TxRef from "effect/TxRef";

import { errorDetailOf } from "../columns.ts";
import { makeTimedWork } from "../engineTick.ts";
import type { Settlement } from "../engineTypes.ts";
import { causeText, fail, isAutomationError } from "../errors.ts";
import { fromJson, toJson } from "../json.ts";
import type { EngineInternals, RunDriver } from "../runDriver.ts";
import { errorDetail } from "../runLog.ts";
import { transientCause } from "../stepPolicy.ts";
import { isoMs, nowIso } from "../time.ts";
import type { AutomationRow, RunRow, StepRow } from "../WorkflowStore.ts";
import { AutomationRunner } from "./AutomationRunner.ts";

/**
 * The run core for a durable workflow backend (`AutomationRunner`): each run
 * is one backend instance, which runs the version's code and journals every
 * step itself. The instance calls the host handlers below from inside its
 * steps; the engine records each step for people to see and executes it with
 * the same step executors the replay core uses. A step that waits (an agent,
 * a question, an event) gets an event type, and the engine sends the outcome
 * as that event when it settles from outside.
 *
 * Every handler is idempotent per run and step key: the backend may call one
 * again after a crash, and code outside steps replays.
 */

/** What a step's first call answers the instance. */
export type HostStepStart =
  | { readonly type: "done"; readonly value: unknown }
  | {
      readonly type: "failed";
      readonly error: string;
      readonly detail?: AutomationErrorDetail | null;
    }
  /** Sleep until `until` (epoch ms), then call `settled`. */
  | { readonly type: "sleep"; readonly until: number }
  /** Wait for event `event`; `timeoutMs` null waits as long as the backend allows. On timeout, call `timedOut`. */
  | { readonly type: "waiting"; readonly event: string; readonly timeoutMs: number | null };

/** How the instance's code ended. */
export type RunEnd =
  | { readonly type: "completed"; readonly output: unknown }
  | { readonly type: "restart"; readonly input: unknown }
  | { readonly type: "failed"; readonly error: string };

export interface HostStepRequest {
  readonly key: string;
  readonly verb: WorkflowStepVerb;
  readonly label: string;
  readonly args: ReadonlyArray<unknown>;
}

/** Branch answers and loop counts the code recorded since its last call, keyed like steps. */
export type Marks = ReadonlyArray<readonly [string, unknown]>;

/** The handlers an instance calls, by run id. */
export interface HostedRunsShape {
  readonly step: (
    runId: string,
    request: HostStepRequest,
    marks: Marks,
  ) => Effect.Effect<HostStepStart, AutomationError>;
  /** A sleep ended. */
  readonly settled: (runId: string, key: string) => Effect.Effect<void, AutomationError>;
  /** A wait timed out: how the step ends (`null` for `waitFor`, the `onTimeout` of an `ask`, a failure). */
  readonly timedOut: (runId: string, key: string) => Effect.Effect<Settlement, AutomationError>;
  /** A step failed after the backend's retries ran out. */
  readonly failed: (
    runId: string,
    key: string,
    error: string,
  ) => Effect.Effect<void, AutomationError>;
  readonly finish: (
    runId: string,
    end: RunEnd,
    marks: Marks,
  ) => Effect.Effect<void, AutomationError>;
  /** When the next cron is due (epoch ms), for the host's alarm; null when none is. */
  readonly nextCronAt: Effect.Effect<number | null, AutomationError>;
  /** The run's automation, version and project, for checking a caller; undefined when gone. */
  readonly runOf: (
    runId: string,
  ) => Effect.Effect<
    | { readonly automationId: string; readonly version: number; readonly projectId: string }
    | undefined,
    AutomationError
  >;
  /** The version's code as the backend loads it; undefined for a version saved without it. */
  readonly workerModule: (
    automationId: string,
    version: number,
  ) => Effect.Effect<string | undefined, AutomationError>;
}

export class HostedRuns extends Context.Service<HostedRuns, HostedRunsShape>()(
  "@signalbox/automations/runner/hostedDriver/HostedRuns",
) {}

/**
 * The backend event a waiting step's outcome is sent as. Backends limit event
 * types (Cloudflare: `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, 100 characters), and step
 * keys hold `#[]./`, so it's a hash of the key: two FNV-1a passes with
 * different bases, 16 hex characters. Keys are unique within a run.
 */
export const eventTypeFor = (key: string) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return `s_${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
};

const settlementOf = (step: StepRow): Settlement | undefined =>
  step.status === "succeeded"
    ? { ok: true, value: fromJson(step.result_json) }
    : step.status === "failed"
      ? {
          ok: false,
          error: step.error ?? "The step failed.",
          detail: errorDetailOf(step.error_detail_json),
        }
      : undefined;

const startOf = (settlement: Settlement): HostStepStart =>
  settlement.ok
    ? { type: "done", value: settlement.value }
    : { type: "failed", error: settlement.error, detail: settlement.detail ?? null };

const runEnded = new AutomationError({ message: "The run already ended." });

export const makeHostedDriver = (core: EngineInternals) =>
  Effect.gen(function* () {
    const { store, runLogs, runWaits, attachments } = core;
    const runner = yield* AutomationRunner;
    const busy = yield* TxRef.make(0);
    const adjustBusy = (delta: number) =>
      TxRef.update(busy, (count) => count + delta).pipe(Effect.tx);
    const drain = TxRef.get(busy).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
      Effect.asVoid,
    );

    /** Steps settling inside a host call: their outcome is the call's answer, not an event. */
    const answering = new Set<string>();
    /** Runs ending from their own instance, which needs no stopping. */
    const finishing = new Set<string>();
    const id = (runId: string, key: string) => `${runId}\u0000${key}`;
    const answered = <A, E, R>(runId: string, key: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => answering.add(id(runId, key))),
        () => effect,
        () => Effect.sync(() => answering.delete(id(runId, key))),
      );

    const timed = yield* makeTimedWork({
      ...core,
      // Retries are the backend's; nothing here parks or replays.
      replays: { retryDue: () => Effect.void },
      execute: () => Effect.void,
      retryOrFail: (step, error, options) =>
        core.complete(step.run_id, step.step_key, {
          ok: false,
          error,
          detail: options?.detail ?? null,
        }),
    });

    const requireRunning = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* store.getRun(runId);
        if (!run || run.status !== "running") return yield* runEnded;
        const automation = yield* store.getAutomation(run.automation_id);
        if (!automation) return yield* fail("The automation behind this run is gone.", { runId });
        return { run, automation };
      });

    /** Merges marks the code recorded into the run's, which run views show. */
    const saveMarks = (run: RunRow, marks: Marks) =>
      Effect.gen(function* () {
        if (marks.length === 0) return;
        const current = (fromJson(run.marks_json) ?? {}) as Record<string, unknown>;
        let changed = false;
        for (const [key, value] of marks) {
          if (key in current && toJson(current[key]) === toJson(value ?? null)) continue;
          current[key] = value ?? null;
          changed = true;
        }
        if (!changed) return;
        yield* store.saveReplay(run.run_id, toJson(current), run.logs_json ?? "[]");
        yield* core.runChanged(run.run_id, false);
      });

    /** What the instance does about a step that waits, from its stored row. */
    const waitingStart = (step: StepRow): Effect.Effect<HostStepStart> =>
      Effect.gen(function* () {
        const wakeAt = step.wake_at === null ? null : isoMs(step.wake_at);
        const now = (yield* DateTime.now).epochMilliseconds;
        const plainTimer = step.thread_id === null && step.verb === "sleep";
        if (plainTimer && wakeAt !== null) return { type: "sleep", until: wakeAt };
        return {
          type: "waiting",
          event: eventTypeFor(step.step_key),
          timeoutMs: wakeAt === null ? null : Math.max(1_000, wakeAt - now),
        };
      });

    /** Starts a step the code reached: runs it inline, or leaves it waiting for an event. */
    const begin = (automation: AutomationRow, step: StepRow) =>
      Effect.gen(function* () {
        yield* runLogs.step(step, { status: "running" });
        const start = yield* core.startStep(automation, step).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            const error = Cause.squash(cause);
            const transient = isAutomationError(error) ? transientCause(error) : undefined;
            if (transient) return Effect.failCause(cause);
            return Effect.succeed({
              type: "failed" as const,
              error: causeText(cause),
              detail: errorDetail(error),
            });
          }),
        );
        if (start.type === "retry") {
          yield* runLogs.step(step, { status: "retrying", error: start.error });
          // Thrown into the backend's step, which retries it with backoff.
          return yield* fail(start.error, { runId: step.run_id });
        }
        if (start.type === "done" || start.type === "failed") {
          const settlement: Settlement =
            start.type === "done"
              ? { ok: true, value: start.value }
              : { ok: false, error: start.error, detail: start.detail };
          yield* answered(
            step.run_id,
            step.step_key,
            core.complete(step.run_id, step.step_key, settlement),
          );
          return startOf(settlement);
        }
        const moved = yield* store.markWaiting(step.run_id, step.step_key, start);
        if (moved) {
          yield* runLogs.step(step, { status: "waiting" });
          yield* core.runChanged(step.run_id, step.verb === "ask");
          yield* attachments.refresh(step.run_id);
          yield* core.announce(automation, step);
        }
        const waiting = yield* store.getStep(step.run_id, step.step_key);
        if (!waiting) return yield* fail("The step is gone.", { runId: step.run_id });
        const done = settlementOf(waiting);
        if (done) return startOf(done);
        const answer = yield* waitingStart(waiting);
        // An event may have come in before the step waited; it goes out as the event now.
        if (step.verb === "waitFor")
          yield* runWaits
            .stepWaiting(waiting)
            .pipe(Effect.andThen(runWaits.deliverPending(step.run_id)));
        return answer;
      });

    const step: HostedRunsShape["step"] = (runId, request, marks) =>
      Effect.gen(function* () {
        const { run, automation } = yield* requireRunning(runId);
        yield* saveMarks(run, marks);
        const existing = yield* store.getStep(runId, request.key);
        if (existing) {
          if (existing.verb !== request.verb || existing.label !== request.label)
            return {
              type: "failed",
              error: `Step ${request.key} was "${existing.label}" and is "${request.label}" now; the code didn't run the same way.`,
            } satisfies HostStepStart;
          const done = settlementOf(existing);
          if (done) return startOf(done);
          if (existing.status === "waiting") return yield* waitingStart(existing);
          // Running: a call cut off mid-step. Starting again is safe; agents and calls use stable ids.
          return yield* begin(automation, existing);
        }
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
          started_at: yield* nowIso,
          finished_at: null,
        };
        yield* store.insertStep(row);
        yield* core.changed({
          kind: "runs",
          automationId: run.automation_id,
          runId,
          summary: false,
        });
        return yield* begin(automation, (yield* store.getStep(runId, request.key)) ?? row);
      }).pipe(
        Effect.withSpan("HostedRuns.step", {
          attributes: { "automation.run_id": runId, "automation.step_verb": request.verb },
        }),
      );

    const settleInline = (runId: string, key: string, settlement: Settlement) =>
      answered(runId, key, core.complete(runId, key, settlement)).pipe(Effect.asVoid);

    const timedOut: HostedRunsShape["timedOut"] = (runId, key) =>
      Effect.gen(function* () {
        const current = yield* store.getStep(runId, key);
        if (!current) return yield* fail("There's no such step.", { runId });
        const already = settlementOf(current);
        if (already) return already;
        yield* answered(runId, key, timed.wakeStep(current));
        const after = yield* store.getStep(runId, key);
        return (
          (after && settlementOf(after)) ?? {
            ok: false,
            error: "The step timed out.",
            detail: null,
          }
        );
      });

    const finish: HostedRunsShape["finish"] = (runId, end, marks) =>
      Effect.gen(function* () {
        const run = yield* store.getRun(runId);
        if (!run || run.status !== "running") return;
        yield* saveMarks(run, marks);
        const current = (yield* store.getRun(runId)) ?? run;
        finishing.add(runId);
        yield* Effect.gen(function* () {
          if (end.type === "completed")
            return yield* core.endRun(current, { status: "succeeded", output: end.output });
          if (end.type === "restart") {
            const automation = yield* store.getAutomation(run.automation_id);
            if (!automation)
              return yield* core.endRun(current, {
                status: "failed",
                error: "The automation behind this run is gone.",
              });
            return yield* core.restart(current, automation, end.input);
          }
          // A step failure nothing caught surfaces with the step's message; keep its explanation.
          const cause = (yield* store.listSteps(runId)).find(
            (candidate) => candidate.status === "failed" && candidate.error === end.error,
          );
          return yield* core.endRun(current, {
            status: "failed",
            error: end.error,
            detail: errorDetailOf(cause?.error_detail_json ?? null),
          });
        }).pipe(Effect.ensuring(Effect.sync(() => finishing.delete(runId))));
      });

    const runs: HostedRunsShape = {
      step,
      settled: (runId, key) => settleInline(runId, key, { ok: true, value: null }),
      timedOut,
      failed: (runId, key, error) => settleInline(runId, key, { ok: false, error, detail: null }),
      finish,
      nextCronAt: timed.nextCronAt,
      runOf: (runId) =>
        Effect.gen(function* () {
          const run = yield* store.getRun(runId);
          if (!run) return undefined;
          const automation = yield* store.getAutomation(run.automation_id);
          if (!automation) return undefined;
          return {
            automationId: run.automation_id,
            version: run.version,
            projectId: automation.project_id,
          };
        }),
      workerModule: store.getVersionWorkerModule,
    };

    const driver: RunDriver = {
      settled: (runId, key, outcome) =>
        answering.has(id(runId, key))
          ? Effect.void
          : runner.sendEvent(runId, eventTypeFor(key), outcome),
      launched: (runId) =>
        Effect.gen(function* () {
          const run = yield* store.getRun(runId);
          if (!run) return yield* fail("That run is gone.", { runId });
          yield* runner.create({
            runId,
            automationId: run.automation_id,
            version: run.version,
            input: fromJson(run.input_json),
            trigger: fromJson(run.trigger_json) ?? { type: run.trigger },
          });
        }),
      ended: (runId) => (finishing.has(runId) ? Effect.void : runner.terminate(runId)),
      settleThreadStep: timed.settleThreadStep,
      tick: timed.crons,
      adjustBusy,
      drain,
    };
    return { driver, runs };
  });
