import {
  CommandId,
  ProjectId,
  resolveAutomationAskAnswer,
  ThreadId,
  workflowNodeIdForStepKey,
  type Automation,
  type AutomationAskAnswerInput,
  type AutomationDetail,
  type AutomationError,
  type AutomationErrorDetail,
  type AutomationNotice,
  type AutomationRunDetail,
  type AutomationRunLog,
  type AutomationRunSummary,
  type AutomationRunTrigger,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  isTerminalRunStatus,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { Scheduler } from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { makeCatalog, type AuthorizeAutomation, type CatalogShape } from "./catalog.ts";
import {
  automationDefaults,
  automationTriggers,
  errorDetailOf,
  runLogLines,
  stepArgs,
  stepAsk,
} from "./columns.ts";
import { makeConnections } from "./connections.ts";
import { makeTimedWork } from "./engineTick.ts";
import type { EndRun, Launch, LaunchRun, RunOutcome, Settlement } from "./engineTypes.ts";
import { automationError, causeText, fail, isAutomationError, logFailure } from "./errors.ts";
import { makeEventTriggers } from "./events/eventTriggers.ts";
import * as ExecutorSettings from "./executorSettings.ts";
import { fromJson, toJson } from "./json.ts";
import { automationShows, listShows, makeLiveFeed, runShows, type Change } from "./liveFeed.ts";
import { automationNotice, failureNotice } from "./notices.ts";
import { makeReplayQueue } from "./replayQueue.ts";
import { makeRunFunction } from "./runFunction.ts";
import { replayWorkflow, type JournalResult } from "./sandbox/replayWorkflow.ts";
import { makeInheritance, makeRetryRun, type RetryRun } from "./retry.ts";
import { makeStartStep, type StepOutcome } from "./startStep.ts";
import { retryDelayMs, retryPolicy, transientCause } from "./stepPolicy.ts";
import { errorDetail, makeRunLogs } from "./runLog.ts";
import { afterMs } from "./steps.ts";
import { isoAt, nowIso } from "./time.ts";
import { runSummary, runTitle } from "./views.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

type Store = WorkflowStore.WorkflowStore;

export type { AuthorizeAutomation };

/** A webhook POST that found its automation: the run it started, or the run an earlier delivery with the same id started. */
export interface WebhookStart {
  readonly runId: string;
  readonly duplicate: boolean;
}

export interface WorkflowEngineShape extends CatalogShape {
  /** Stops its running runs, then deletes it with everything it stored and installed. */
  readonly remove: (automationId: string) => Effect.Effect<void, AutomationError>;
  /** Starts a run, also of a paused automation: someone asked for this one. */
  readonly startRun: <E = never>(input: {
    readonly automationId: string;
    readonly input?: unknown;
    readonly trigger: AutomationRunTrigger;
    readonly authorize?: AuthorizeAutomation<E>;
  }) => Effect.Effect<AutomationRunSummary, AutomationError | E>;
  /**
   * Starts a run from a webhook POST. Null when the token doesn't match a live
   * webhook automation. A repeated `requestKey` within a day returns the first
   * delivery's run instead of starting another.
   */
  readonly startFromWebhook: (input: {
    readonly token: string;
    readonly payload: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly rawBody?: string;
    readonly requestKey?: string;
  }) => Effect.Effect<WebhookStart | null, AutomationError>;
  /** Ends a run now: interrupts its agents, requests and processes, and cancels runs it started. */
  readonly cancelRun: (runId: string) => Effect.Effect<void, AutomationError>;
  /** Starts a new run retrying a failed or cancelled one, reusing the steps that went well. */
  readonly retryRun: RetryRun;
  /** Answers a waiting `ask` step, checked against its options and fields. Only people answer; agents can't. */
  readonly answer: (
    input: {
      readonly runId: string;
      readonly stepKey: string;
    } & AutomationAskAnswerInput,
  ) => Effect.Effect<void, AutomationError>;
  /** Delivers an event to every running `waitFor` step waiting on it; returns how many it woke. */
  readonly emit: (input: {
    readonly event: string;
    readonly payload?: unknown;
  }) => Effect.Effect<number, AutomationError>;
  /** Every automation, now and after each batch of changes. */
  readonly subscribeList: () => Stream.Stream<ReadonlyArray<Automation>, AutomationError>;
  /** One automation with its recent runs, now and after each batch of changes to it. */
  readonly subscribeAutomation: (
    automationId: string,
  ) => Stream.Stream<AutomationDetail, AutomationError>;
  /** One run with its steps, now and after each batch of changes to it. */
  readonly subscribeRun: (runId: string) => Stream.Stream<AutomationRunDetail, AutomationError>;
  /**
   * Notices from now on: an ask started waiting, a notify ran, or a run
   * failed. Subscribes when run, in the caller's scope, so nothing published
   * after it is missed.
   */
  readonly subscribeNotices: Effect.Effect<Stream.Stream<AutomationNotice>, never, Scope.Scope>;
  /**
   * Due crons, timers, timeouts, retries and agent checks, plus hourly
   * cleanup. The scheduler calls this every few seconds; one bad item never
   * blocks the rest.
   */
  readonly tick: Effect.Effect<void, AutomationError>;
  /** Waits until no replay is queued and no step is running. Waiting steps don't count. */
  readonly drain: Effect.Effect<void>;
}

export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()(
  "t3/workflows/WorkflowEngine",
) {}

const REPLAY_MISMATCH: AutomationErrorDetail = {
  why: "A step's label came out different on replay, usually because it's built from Date.now(), Math.random() or data that changed between replays.",
  fix: "Build step labels from the input and step results only, then run the automation again.",
  link: null,
};

const make = Effect.gen(function* () {
  const store: Store = yield* WorkflowStore.make;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService;
  const scheduler = yield* Scheduler;
  // Steps run in forked fibers; they get the services they use from here.
  const required = yield* Effect.context<
    ThreadLaunchService | ThreadManagementService | HttpClient.HttpClient
  >();
  // The provider catalog, when the server has one, tells agent steps each model's option names.
  const providerCatalog = yield* Effect.serviceOption(ProviderRegistry);
  const services = Option.isSome(providerCatalog)
    ? Context.add(required, ProviderRegistry, providerCatalog.value)
    : required;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<Change>();
  const projects = yield* ProjectService;
  const runFunction = yield* makeRunFunction;
  const connections = yield* makeConnections;
  const runLogs = yield* makeRunLogs;
  const replays = yield* makeReplayQueue;
  const notices = yield* PubSub.unbounded<AutomationNotice>();
  const newId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => `${prefix}_${uuid}`),
      Effect.mapError((cause) => automationError("Couldn't create an id.", { cause })),
    );
  const ignoreFailure = (what: string) => logFailure(`Automation ${what} failed`);

  const events = yield* makeEventTriggers({
    store,
    threads,
    adjustBusy: replays.adjustBusy,
    notify: (notice) => PubSub.publish(notices, notice).pipe(Effect.asVoid),
    // Called only once events flow, after launchRun below exists.
    launchRun: (launch) => launchRun(launch),
  });

  const changed = (change: Change) =>
    Effect.suspend(() => {
      if (change.kind === "definition") events.invalidate(change.automationId);
      return PubSub.publish(changes, change).pipe(Effect.asVoid);
    });
  /** A run changed; `summary` when run lists show it (it started or ended, a question waits or was answered). */
  const runChanged = (runId: string, summary: boolean) =>
    store
      .getRunMeta(runId)
      .pipe(
        Effect.flatMap((run) =>
          run
            ? changed({ kind: "runs", automationId: run.automation_id, runId, summary })
            : Effect.void,
        ),
      );
  /** Called only on a step's one transition into waiting or done, so each step notifies once. */
  const announce = (automation: WorkflowStore.AutomationRow, step: WorkflowStore.StepRow) =>
    Effect.gen(function* () {
      const notice = automationNotice({ automation, step, at: yield* nowIso });
      if (notice) yield* PubSub.publish(notices, notice);
      if (step.verb === "ask")
        yield* events.automationEvent("automation.ask.waiting", step.run_id, {
          stepKey: step.step_key,
          label: step.label,
          question: stepAsk(step).ask.question,
        });
    });

  /** Step fibers per run, so ending a run interrupts its requests and processes. */
  const inflight = new Map<string, Set<Fiber.Fiber<unknown, unknown>>>();
  const interruptSteps = (runId: string) =>
    Effect.withFiber((current) => {
      const fibers = [...(inflight.get(runId) ?? [])].filter((fiber) => fiber !== current);
      inflight.delete(runId);
      return Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    });

  const requireAutomation = (automationId: string) =>
    store.getAutomation(automationId).pipe(
      Effect.filterOrFail(
        (row): row is WorkflowStore.AutomationRow => row !== undefined,
        () => automationError("That automation doesn't exist.", { automationId }),
      ),
    );
  const automationOfRun = (runId: string) =>
    Effect.gen(function* () {
      const run = yield* store.getRunMeta(runId);
      return run ? yield* store.getAutomation(run.automation_id) : undefined;
    });

  /** Settles a step once and replays its run. False when it was already settled. */
  const complete = (runId: string, key: string, outcome: Settlement) =>
    Effect.gen(function* () {
      const settled = yield* store.completeStep(
        runId,
        key,
        outcome.ok
          ? { ok: true, value: toJson(outcome.value ?? null) }
          : {
              ok: false,
              error: outcome.error,
              errorDetail: outcome.detail ? toJson(outcome.detail) : null,
            },
        yield* nowIso,
      );
      if (!settled) return false;
      const duration = runLogs.durationOf(settled);
      yield* runLogs.step(settled, {
        status: outcome.ok ? "succeeded" : "failed",
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(outcome.ok ? {} : { error: outcome.error, detail: outcome.detail ?? null }),
      });
      if (!outcome.ok)
        yield* events.automationEvent("automation.step.failed", runId, {
          stepKey: key,
          verb: settled.verb,
          label: settled.label,
          error: outcome.error,
        });
      // An answered question stops the run waiting on someone, which run lists show.
      yield* runChanged(runId, settled.verb === "ask");
      yield* replays.enqueue(runId);
      return true;
    });

  /**
   * Parks a failed attempt until its backoff ends, or fails the step when its
   * retries are used up. The attempt count is journaled, so a restart neither
   * loses nor repeats a retry.
   */
  const retryOrFail = (
    step: WorkflowStore.StepRow,
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
        yield* runChanged(step.run_id, false);
      }
      return false;
    });

  const startStep = makeStartStep({
    store,
    services,
    projects,
    runFunction,
    connections,
    launchChild: ({ automation, input, parent }) =>
      launchRun({ automation, input, trigger: "automation", parent }).pipe(
        Effect.map(({ run }) => run),
      ),
  });

  /** Runs a step the code just reached, in a fiber the run owns. Waiting steps finish later from outside. */
  const execute = (automation: WorkflowStore.AutomationRow, step: WorkflowStore.StepRow) => {
    const work = runLogs.step(step, { status: "running" }).pipe(
      Effect.andThen(startStep(automation, step)),
      Effect.flatMap((start: StepOutcome) => {
        switch (start.type) {
          case "done":
            return complete(step.run_id, step.step_key, { ok: true, value: start.value });
          case "retry":
            return retryOrFail(step, start.error, { retryAfterMs: start.retryAfterMs });
          case "waiting":
            return store
              .markWaiting(step.run_id, step.step_key, start)
              .pipe(
                Effect.tap((moved) =>
                  moved
                    ? runLogs
                        .step(step, { status: "waiting" })
                        .pipe(Effect.andThen(runChanged(step.run_id, step.verb === "ask")))
                    : Effect.void,
                ),
              );
        }
      }),
      // Only the call that moved the step tells the user, so restarts and replays can't repeat it.
      Effect.tap((moved) => (moved ? announce(automation, step) : Effect.void)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        const detail = errorDetail(error);
        const transient = isAutomationError(error) ? transientCause(error) : undefined;
        return transient
          ? retryOrFail(step, causeText(cause), { retryAfterMs: transient.retryAfterMs, detail })
          : complete(step.run_id, step.step_key, { ok: false, error: causeText(cause), detail });
      }),
      ignoreFailure("step couldn't be recorded"),
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
        Effect.andThen(tracked.pipe(Effect.ensuring(replays.adjustBusy(-1)), Effect.forkIn(scope))),
        Effect.asVoid,
      );
  };

  /**
   * Ends a running run once, and everything still working for it: step
   * fibers, agent threads, open steps, and on cancel the runs it started.
   * False when it had already ended. The run's `logs_json` is what its event
   * records, so a replay passes the lines it just saved.
   */
  const endRun: EndRun = (run, outcome) =>
    Effect.gen(function* () {
      const { status } = outcome;
      const steps = yield* store.listSteps(run.run_id);
      const now = yield* DateTime.now;
      const nowText = DateTime.formatIso(now);
      const title = outcome.status === "succeeded" ? runTitle(steps, outcome.output) : null;
      const error = outcome.status === "failed" ? outcome.error : null;
      const detail = outcome.status === "failed" ? (outcome.detail ?? null) : null;
      const ended = yield* store.finishRun(
        run.run_id,
        {
          status,
          output: outcome.status === "succeeded" ? toJson(outcome.output ?? null) : null,
          error,
          errorDetail: detail ? toJson(detail) : null,
          title,
        },
        nowText,
      );
      if (!ended) return false;
      yield* replays.forget(run.run_id);
      yield* interruptSteps(run.run_id);
      const automation = yield* store.getAutomation(run.automation_id);
      for (const step of steps) {
        if (step.thread_id === null || (step.status !== "running" && step.status !== "waiting"))
          continue;
        if (!automation) continue;
        yield* threads
          .interruptThread({
            projectId: ProjectId.make(automation.project_id),
            commandId: CommandId.make(`automation:${run.run_id}:${step.step_key}:stop`),
            threadId: ThreadId.make(step.thread_id),
            reason: "The automation run ended.",
          })
          .pipe(Effect.ignore);
      }
      yield* store.closeOpenSteps(
        run.run_id,
        status === "cancelled"
          ? "The run was cancelled."
          : "The run ended before this step finished.",
        nowText,
      );
      if (status === "cancelled") {
        for (const child of yield* store.runningChildren(run.run_id))
          yield* endRunById(child, { status: "cancelled" });
      }
      yield* changed({
        kind: "runs",
        automationId: run.automation_id,
        runId: run.run_id,
        summary: true,
      });
      yield* events.automationEvent(
        `automation.run.${status}`,
        run.run_id,
        status === "failed" ? { error } : status === "succeeded" ? { title } : {},
      );
      if (status === "failed" && automation) {
        yield* PubSub.publish(
          notices,
          failureNotice({ automation, run, error: error ?? "The run failed.", at: nowText }),
        );
      }
      yield* runLogs.finished(run, automation, {
        status,
        error,
        detail,
        logs: runLogLines(run),
        durationMs: now.epochMilliseconds - DateTime.makeUnsafe(run.started_at).epochMilliseconds,
      });
      return true;
    });
  const endRunById = (
    runId: string,
    outcome: Extract<RunOutcome, { readonly status: "failed" | "cancelled" }>,
  ): Effect.Effect<boolean, AutomationError> =>
    store
      .getRun(runId)
      .pipe(
        Effect.flatMap((run) =>
          run?.status === "running" ? endRun(run, outcome) : Effect.succeed(false),
        ),
      );

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
        const row: WorkflowStore.StepRow = {
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
        yield* changed({ kind: "runs", automationId: run.automation_id, runId, summary: false });
    });

  const launchRun: LaunchRun = (launch: Launch) =>
    Effect.gen(function* () {
      const { retryOf } = launch;
      if (launch.automation.version === 0) {
        return yield* fail(
          `"${launch.automation.name}" isn't published yet. Publish its draft first.`,
          { automationId: launch.automation.automation_id },
        );
      }
      const now = yield* DateTime.now;
      const row = {
        run_id: launch.runId ?? (yield* newId("run")),
        automation_id: launch.automation.automation_id,
        version: launch.version ?? launch.automation.version,
        status: "running",
        trigger: launch.trigger,
        input_json: toJson(launch.input ?? null),
        output_json: null,
        error: null,
        marks_json: "{}",
        trigger_json: retryOf
          ? retryOf.trigger_json
          : toJson({ type: launch.trigger, ...launch.webhook, ...launch.event }),
        parent_run_id: launch.parent?.run_id ?? null,
        depth: retryOf
          ? retryOf.depth
          : launch.parent
            ? launch.parent.depth + 1
            : (launch.depth ?? 0),
        deadline_at:
          launch.automation.timeout_ms === null
            ? null
            : isoAt(now.epochMilliseconds + launch.automation.timeout_ms),
        retry_of_run_id: retryOf?.run_id ?? null,
        replay_seed: retryOf ? (retryOf.replay_seed ?? retryOf.run_id) : null,
        replay_started_at: retryOf ? (retryOf.replay_started_at ?? retryOf.started_at) : null,
        started_at: DateTime.formatIso(now),
        finished_at: null,
      } satisfies WorkflowStore.NewRun;
      if (launch.claim) {
        const claim = launch.claim;
        const prior = yield* store.withTransaction(
          Effect.gen(function* () {
            const existing = yield* claim(row.run_id);
            if (existing === undefined) yield* store.insertRun(row);
            return existing;
          }),
        );
        if (prior !== undefined) {
          const existing = yield* store.getRun(prior);
          if (!existing) return yield* fail("That run is gone.", { runId: prior });
          return { run: runSummary(existing), duplicate: true };
        }
      } else {
        yield* store.insertRun(row);
      }
      yield* runLogs.started(row, launch.automation);
      yield* events.automationEvent("automation.run.started", row.run_id, {
        trigger: launch.trigger,
      });
      yield* changed({
        kind: "runs",
        automationId: row.automation_id,
        runId: row.run_id,
        summary: true,
      });
      yield* replays.enqueue(row.run_id);
      return {
        run: runSummary({
          ...row,
          waiting_on_you: 0,
          title: null,
          error_detail_json: null,
        }),
        duplicate: false,
      };
    });

  const startRun: WorkflowEngineShape["startRun"] = (input) =>
    Effect.gen(function* () {
      const automation = yield* requireAutomation(input.automationId);
      if (input.authorize) yield* input.authorize(automationDefaults(automation));
      return (yield* launchRun({ automation, input: input.input, trigger: input.trigger })).run;
    });

  const remove: WorkflowEngineShape["remove"] = (automationId) =>
    Effect.gen(function* () {
      yield* requireAutomation(automationId);
      for (const runId of yield* store.runningRunsOf(automationId)) {
        yield* endRunById(runId, { status: "cancelled" });
      }
      yield* store.withTransaction(store.deleteAutomation(automationId));
      yield* runFunction.remove(automationId).pipe(ignoreFailure("files couldn't be deleted"));
      yield* changed({ kind: "definition", automationId });
    });

  const startFromWebhook: WorkflowEngineShape["startFromWebhook"] = (input) =>
    Effect.gen(function* () {
      const automation = yield* store.getAutomationByWebhook(input.token);
      if (
        !automation ||
        automation.enabled !== 1 ||
        !automationTriggers(automation).some((trigger) => "webhook" in trigger)
      ) {
        return null;
      }
      const now = yield* DateTime.now;
      const key = input.requestKey;
      const started = yield* launchRun({
        automation,
        input: input.payload,
        trigger: "webhook",
        webhook: { headers: input.headers ?? {}, rawBody: input.rawBody ?? "" },
        ...(key
          ? {
              claim: (runId: string) =>
                store.claimRequestKey({
                  automationId: automation.automation_id,
                  key,
                  runId,
                  now,
                }),
            }
          : {}),
      });
      return { runId: started.run.id, duplicate: started.duplicate } satisfies WebhookStart;
    });

  const answer: WorkflowEngineShape["answer"] = (input) =>
    Effect.gen(function* () {
      const step = yield* store.getStep(input.runId, input.stepKey);
      if (!step || step.verb !== "ask")
        return yield* fail("There's no question waiting there.", { runId: input.runId });
      if (step.status !== "waiting")
        return yield* fail("That question was already answered.", { runId: input.runId });
      const resolved = resolveAutomationAskAnswer(stepAsk(step).ask, input);
      if (!resolved.ok) return yield* fail(resolved.error, { runId: input.runId });
      yield* complete(input.runId, input.stepKey, { ok: true, value: resolved.value });
    });

  const emit: WorkflowEngineShape["emit"] = (input) =>
    store
      .waitingForEvent(input.event)
      .pipe(
        Effect.flatMap((steps) =>
          Effect.forEach(steps, (step) =>
            complete(step.run_id, step.step_key, { ok: true, value: input.payload ?? null }),
          ).pipe(Effect.map((woke) => woke.filter(Boolean).length)),
        ),
      );

  const cancelRun: WorkflowEngineShape["cancelRun"] = (runId) =>
    Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!run) return yield* fail("That run doesn't exist.", { runId });
      yield* endRun(run, { status: "cancelled" });
    });

  const retryRun = makeRetryRun({ store, requireAutomation, launchRun });

  const catalog = makeCatalog({ store, newId, changed, requireAutomation });

  const { settleThreadStep, tick } = yield* makeTimedWork({
    store,
    threads,
    services,
    runFunction,
    runLogs,
    changed,
    runChanged,
    replays,
    complete,
    retryOrFail,
    execute,
    endRun,
    launchRun,
    automationOfRun,
    ignoreFailure,
  });

  const feed = yield* makeLiveFeed(changes);
  yield* forkParked(events.worker);

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

  // Thread-backed steps finish when their thread's run ends. Settling reads the thread, so it
  // runs off the domain event stream, which event triggers match against too.
  const settles = yield* Queue.unbounded<string>();
  yield* forkParked(
    Queue.take(settles).pipe(
      Effect.flatMap((threadId) =>
        store.stepForThread(threadId).pipe(
          Effect.flatMap((step) => (step ? settleThreadStep(step) : Effect.void)),
          logFailure("Automation step couldn't settle"),
          Effect.ensuring(replays.adjustBusy(-1)),
        ),
      ),
      Effect.forever,
    ),
  );
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      events
        .offer(event)
        .pipe(
          Effect.andThen(
            event.type === "run.updated" && isTerminalRunStatus(event.payload.status)
              ? replays
                  .adjustBusy(1)
                  .pipe(Effect.andThen(Queue.offer(settles, event.threadId)), Effect.asVoid)
              : Effect.void,
          ),
        ),
    ),
  );

  // Startup recovery: restart steps a restart cut off, then replay running runs.
  yield* forkParked(
    Effect.gen(function* () {
      for (const step of yield* store.stepsWithStatus("running")) {
        const automation = yield* automationOfRun(step.run_id);
        if (automation) yield* execute(automation, step);
      }
      for (const { run_id } of yield* store.runningRuns()) yield* replays.enqueue(run_id);
    }).pipe(logFailure("Automation recovery failed")),
  );
  yield* scheduler.register("automations", tick);

  return {
    ...catalog,
    remove,
    startRun,
    startFromWebhook,
    cancelRun,
    retryRun,
    answer,
    emit,
    subscribeList: () => feed.watch("list", catalog.list(), listShows, { keepOnFailure: true }),
    subscribeAutomation: (automationId) =>
      feed.watch(
        `automation:${automationId}`,
        catalog.get(automationId),
        automationShows(automationId),
      ),
    subscribeRun: (runId) => feed.watch(`run:${runId}`, catalog.getRun(runId), runShows(runId)),
    subscribeNotices: PubSub.subscribe(notices).pipe(Effect.map(Stream.fromSubscription)),
    tick,
    drain: replays.drain,
  } satisfies WorkflowEngineShape;
});

export const layer = Layer.effect(WorkflowEngine, make).pipe(
  Layer.provide(Layer.mergeAll(ProcessRunner.layer, ExecutorSettings.layer)),
);
