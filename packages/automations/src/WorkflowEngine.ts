import {
  CommandId,
  ProjectId,
  resolveAutomationAskAnswer,
  ThreadId,
  workflowNodeIdForStepKey,
  type Automation,
  type AutomationAskAnswerInput,
  type AutomationBuiltIn,
  type AutomationDefaults,
  type AutomationDetail,
  type AutomationError,
  type AutomationErrorDetail,
  type AutomationNotice,
  type AutomationRunDetail,
  type AutomationRunAttach,
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

import { makeAttachments } from "./attachments.ts";
import { makeBuiltinTools, type BuiltinToolHandler } from "./builtinTools/runner.ts";
import { makeCatalog, type AuthorizeAutomation, type CatalogShape } from "./catalog.ts";
import { automationDefaults, errorDetailOf, runLogLines, stepArgs, stepAsk } from "./columns.ts";
import { makeConnections } from "./connections.ts";
import type {
  EndRun,
  EngineServices,
  Launch,
  LaunchRun,
  RunOutcome,
  Settlement,
} from "./engineTypes.ts";
import { automationError, causeText, fail, isAutomationError, logFailure } from "./errors.ts";
import { makeBuiltIns, type BuiltInPlace } from "./defaults/builtIns.ts";
import * as HostStore from "./defaults/hostStore.ts";
import { BUILT_IN_AUTOMATIONS, builtInSummary } from "./defaults/registry.ts";
import { makeEventTriggers } from "./events/eventTriggers.ts";
import { makePullRequestTracker } from "./events/pullRequestFacts.ts";
import type { PullRequestReads } from "./events/pullRequestDetails.ts";
import { makeRunWaits, stepWatch } from "./events/runWaits.ts";
import {
  AutomationCompiler,
  AutomationFunctions,
  AutomationIngress,
  AutomationModels,
  AutomationThreads,
  forkRoot,
} from "./host.ts";
import { asRecord, fromJson, toJson } from "./json.ts";
import { automationShows, listShows, makeLiveFeed, runShows, type Change } from "./liveFeed.ts";
import { automationNotice, failureNotice } from "./notices.ts";
import { makeRestart } from "./restart.ts";
import * as RunLinkStore from "./runLinkStore.ts";
import { makeReplayDriver } from "./replayDriver.ts";
import { makeRetryRun, type RetryRun } from "./retry.ts";
import type { EngineInternals, RunDriver } from "./runDriver.ts";
import { isTerminalRunStatus } from "./runs.ts";
import { makeStartStep } from "./startStep.ts";
import { makeRunLogs } from "./runLog.ts";
import { isoAt, nowIso } from "./time.ts";
import { runSummary, runTitle } from "./views.ts";
import { makeWaits, type Waits } from "./waits.ts";
import * as SourceStore from "./sources/sourceStore.ts";
import { makeSourceWatches } from "./sources/sourceWatches.ts";
import { scopeOf, sourceIdOf } from "./sources/watch.ts";
import { watchersOf } from "./sources/watchers.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

type Store = WorkflowStore.WorkflowStore;

export type { AuthorizeAutomation };

export interface WorkflowEngineShape extends CatalogShape {
  /** Stops its running runs, then deletes it with everything it stored and installed. */
  readonly remove: (automationId: string) => Effect.Effect<void, AutomationError>;
  /** Starts a run, also of a paused automation: someone asked for this one. */
  readonly startRun: <E = never>(input: {
    readonly automationId: string;
    readonly input?: unknown;
    readonly trigger: AutomationRunTrigger;
    readonly authorize?: AuthorizeAutomation<E>;
    /** Binds the run to a thread (see attachments.ts). */
    readonly attach?: AutomationRunAttach | undefined;
    /**
     * For a `builtin:<slug>` id: the project to run it in (default: the
     * attached thread's) and the defaults its host row starts with there.
     */
    readonly projectId?: string | undefined;
    readonly builtInDefaults?: AutomationDefaults | undefined;
  }) => Effect.Effect<AutomationRunSummary, AutomationError | E>;
  /** Built-in automations Signalbox ships (see defaults/registry.ts). */
  readonly builtIns: Effect.Effect<ReadonlyArray<AutomationBuiltIn>>;
  /** Makes a built-in a project's own, editable automation. */
  readonly customize: (
    automationId: string,
    place: BuiltInPlace,
  ) => Effect.Effect<Automation, AutomationError>;
  /** Stop on a thread: cancels the runs attached to it; returns how many. */
  readonly cancelAttached: (threadId: string) => Effect.Effect<number, AutomationError>;
  /** An agent's waits: built-in runs attached to its thread (see waits.ts). */
  readonly startWait: Waits["start"];
  readonly listWaits: Waits["list"];
  readonly stopWait: Waits["stop"];
  readonly watchPullRequest: Waits["watchPullRequest"];
  readonly requestMerge: Waits["requestMerge"];
  /** The MCP server hands over Signalbox's tools for `w.call("…", "signalbox.<tool>")`. */
  readonly registerBuiltinTools: (handler: BuiltinToolHandler) => Effect.Effect<void>;
  /** The server registers pull request reads once its pull request service exists. */
  readonly registerPullRequestReads: (reads: PullRequestReads) => Effect.Effect<void>;
  /** Sets or clears (null) the webhook signing secret; it is never read back. */
  readonly setWebhookSecret: <E = never>(input: {
    readonly automationId: string;
    readonly secret: string | null;
    readonly authorize?: AuthorizeAutomation<E>;
  }) => Effect.Effect<Automation, AutomationError | E>;
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
   * Due timed work (crons, and in the replay core timers, timeouts, retries
   * and agent checks), plus hourly cleanup. One bad item never blocks the rest.
   */
  readonly tick: Effect.Effect<void, AutomationError>;
  /** Waits until nothing the engine started is still working. Waiting steps don't count. */
  readonly drain: Effect.Effect<void>;
}

export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()(
  "@signalbox/automations/WorkflowEngine",
) {}

/**
 * The engine around a run core: catalog, triggers, waits, attachments and the
 * step executors, with `makeDriver` running the code (see runDriver.ts).
 */
export const makeEngine = <R>(
  makeDriver: (internals: EngineInternals) => Effect.Effect<RunDriver, never, R>,
) =>
  Effect.gen(function* () {
    const store: Store = yield* WorkflowStore.make;
    const links = yield* RunLinkStore.make;
    const hosts = yield* HostStore.make;
    const builtinTools = makeBuiltinTools({
      approvalOf: (runId) =>
        Effect.gen(function* () {
          const run = yield* store.getRun(runId);
          const version = run ? yield* store.getVersion(run.automation_id, run.version) : undefined;
          return version?.approved_by ?? null;
        }),
      projectOfThread: (threadId) => projectOfThread(threadId),
    });
    const crypto = yield* Crypto.Crypto;
    const threads = yield* AutomationThreads;
    // Steps run in forked fibers; they get the services they use from here.
    const required = yield* Effect.context<EngineServices>();
    // The host's models, when it has a catalog, tell agent steps each model's option names.
    const models = yield* Effect.serviceOption(AutomationModels);
    const services = Option.isSome(models)
      ? Context.add(required, AutomationModels, models.value)
      : required;
    const scope = yield* Effect.scope;
    const changes = yield* PubSub.unbounded<Change>();
    const functions = yield* AutomationFunctions;
    const compiler = yield* AutomationCompiler;
    const connections = yield* makeConnections;
    const runLogs = yield* makeRunLogs;
    // Bound once the driver is built, before any event or run can reach it.
    let driver: RunDriver | undefined;
    const theDriver = () => {
      if (driver === undefined) throw new Error("The automation run core isn't ready.");
      return driver;
    };
    const notices = yield* PubSub.unbounded<AutomationNotice>();
    const newId = (prefix: string) =>
      crypto.randomUUIDv4().pipe(
        Effect.map((uuid) => `${prefix}_${uuid}`),
        Effect.mapError((cause) => automationError("Couldn't create an id.", { cause })),
      );
    const ignoreFailure = (what: string) => logFailure(`Automation ${what} failed`);

    // These call back into the run core below once runs exist.
    const runWaits = makeRunWaits({
      store,
      links,
      complete: (runId, key, outcome) => complete(runId, key, outcome),
    });
    const attachments = makeAttachments({
      store,
      links,
      threads,
      cancel: (runId) => endRunById(runId, { status: "cancelled" }),
    });
    let pullRequestReads: PullRequestReads | undefined;
    const events = yield* makeEventTriggers({
      store,
      threads,
      adjustBusy: (delta) => theDriver().adjustBusy(delta),
      notify: (notice) => PubSub.publish(notices, notice).pipe(Effect.asVoid),
      // Called only once events flow, after launchRun below exists.
      launchRun: (launch) => launchRun(launch),
      runWaits,
      pullRequests: makePullRequestTracker((yield* DateTime.now).epochMilliseconds),
      pullRequestReads: () => pullRequestReads,
    });
    const ingress = yield* (yield* AutomationIngress).make({
      store,
      newId,
      // Called only once requests arrive, after launchRun below exists.
      launchRun: (launch) => launchRun(launch),
      deliverTo: (runId, envelope) =>
        runWaits
          .deliver(envelope, [{ runId, projectId: envelope.projectId, patterns: ["hook.called"] }])
          .pipe(logFailure("Automation callback delivery failed")),
    });

    const sourceStore = yield* SourceStore.make;
    const sourceWatchers = watchersOf({
      triggers: events.watchingTriggers,
      runs: runWaits.watching,
    });
    const sources = makeSourceWatches({
      store: sourceStore,
      watchers: sourceWatchers,
      read: connections.call,
      publish: events.sourceEvent,
      notify: (notice) => PubSub.publish(notices, notice).pipe(Effect.asVoid),
      checked: (watchers) =>
        Effect.forEach(
          new Map(
            watchers.map((watcher) => [
              `${watcher.automation.automation_id}/${watcher.runId ?? ""}`,
              watcher,
            ]),
          ).values(),
          (watcher) =>
            changed({
              kind: "sources",
              automationId: watcher.automation.automation_id,
              ...(watcher.runId ? { runId: watcher.runId } : {}),
            }),
          { discard: true },
        ),
      paused: (sourceId, watchers, error) =>
        Effect.forEach(
          new Set(watchers.flatMap((watcher) => (watcher.runId ? [watcher.runId] : []))),
          (runId) =>
            Effect.gen(function* () {
              const run = yield* store.getRunMeta(runId);
              const automation = run ? yield* store.getAutomation(run.automation_id) : undefined;
              if (!automation) return;
              for (const step of yield* store.listSteps(runId)) {
                const watch = step.status === "waiting" ? stepWatch(step) : undefined;
                if (watch && sourceIdOf(scopeOf(automation), watch) === sourceId)
                  yield* complete(runId, step.step_key, { ok: false, error });
              }
            }).pipe(ignoreFailure("source pause")),
          { discard: true },
        ),
      adjustBusy: (delta) => theDriver().adjustBusy(delta),
      scope,
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

    /** Settles a step once and lets the driver wake its run. False when it was already settled. */
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
        yield* attachments.refresh(runId);
        yield* theDriver().settled(runId, key, outcome);
        return true;
      });

    const startStep = makeStartStep({
      store,
      services,
      functions,
      connections,
      builtinTools,
      callback: (runId) => ingress.createCallback(runId),
      resolveBuiltIn: (name, automation) =>
        builtIns.resolveName(name, {
          projectId: automation.project_id,
          defaults: automationDefaults(automation),
        }),
      launchChild: ({ automation, input, parent }) =>
        launchRun({ automation, input, trigger: "automation", parent }).pipe(
          Effect.map(({ run }) => run),
        ),
    });

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
        yield* theDriver().ended(run.run_id, status);
        yield* runWaits.ended(run.run_id);
        yield* ingress.runEnded(run.run_id);
        yield* attachments.refresh(run.run_id);
        const automation = yield* store.getAutomation(run.automation_id);
        for (const step of steps) {
          if (step.thread_id === null || (step.status !== "running" && step.status !== "waiting"))
            continue;
          if (!automation) continue;
          yield* threads
            .interrupt({
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
        const startedAt = DateTime.formatIso(now);
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
          // A retry replays the run it retries, so it keeps that run's `at`. A restart is a new
          // run with an empty history: it keeps the trigger but starts at its own time.
          trigger_json: retryOf
            ? retryOf.trigger_json
            : toJson({
                ...(launch.triggerJson
                  ? asRecord(fromJson(launch.triggerJson))
                  : {
                      type: launch.trigger,
                      ...launch.webhook,
                      ...launch.event,
                      ...(launch.link?.thread_id
                        ? {
                            attach: {
                              threadId: launch.link.thread_id,
                              key: launch.link.attach_key,
                              label: launch.link.label,
                            },
                          }
                        : {}),
                    }),
                at: startedAt,
              }),
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
          started_at: startedAt,
          finished_at: null,
        } satisfies WorkflowStore.NewRun;
        const link = launch.link;
        const insert = store.insertRun(row).pipe(
          Effect.andThen(
            link
              ? links.insertLink({
                  ...link,
                  run_id: row.run_id,
                  lineage_id: link.lineage_id ?? row.run_id,
                  started_at: row.started_at,
                })
              : Effect.void,
          ),
        );
        if (launch.claim) {
          const claim = launch.claim;
          const prior = yield* store.withTransaction(
            Effect.gen(function* () {
              const existing = yield* claim(row.run_id);
              if (existing === undefined) yield* insert;
              return existing;
            }),
          );
          if (prior !== undefined) {
            const existing = yield* store.getRun(prior);
            if (!existing) return yield* fail("That run is gone.", { runId: prior });
            return { run: runSummary(existing), duplicate: true };
          }
        } else {
          yield* store.withTransaction(insert);
        }
        runWaits.invalidate();
        yield* attachments.refresh(row.run_id);
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
        yield* theDriver()
          .launched(row.run_id)
          .pipe(
            Effect.tapError((error) =>
              endRunById(row.run_id, { status: "failed", error: error.message }).pipe(
                Effect.ignore,
              ),
            ),
          );
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
        const projectId =
          input.projectId ??
          (input.attach ? yield* projectOfThread(input.attach.threadId) : undefined);
        const automation = yield* builtIns.resolve(
          input.automationId,
          projectId && input.builtInDefaults
            ? { projectId, defaults: input.builtInDefaults }
            : undefined,
        );
        if (input.authorize) yield* input.authorize(automationDefaults(automation));
        const attached = input.attach ? yield* attachments.launchFor(automation, input.attach) : {};
        return (yield* launchRun({
          automation,
          input: input.input,
          trigger: input.trigger,
          ...attached,
        })).run;
      });

    const remove: WorkflowEngineShape["remove"] = (automationId) =>
      Effect.gen(function* () {
        yield* requireAutomation(automationId);
        for (const runId of yield* store.runningRunsOf(automationId)) {
          yield* endRunById(runId, { status: "cancelled" });
        }
        yield* store.withTransaction(store.deleteAutomation(automationId));
        yield* ingress.forget(automationId);
        yield* functions.remove(automationId).pipe(ignoreFailure("files couldn't be deleted"));
        yield* changed({ kind: "definition", automationId });
      });

    const setWebhookSecret: WorkflowEngineShape["setWebhookSecret"] = (input) =>
      Effect.gen(function* () {
        const automation = yield* requireAutomation(input.automationId);
        if (input.authorize) yield* input.authorize(automationDefaults(automation));
        yield* ingress.setSecret(input.automationId, input.secret);
        yield* changed({ kind: "automation", automationId: input.automationId });
        return (yield* catalog.get(input.automationId)).automation;
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
    const restart = makeRestart({ store, links, newId, endRun, launchRun });
    const projectOfThread = (threadId: string) =>
      threads.getThreadShell(ThreadId.make(threadId)).pipe(
        Effect.map((shell) => shell?.projectId),
        Effect.mapError((cause) => automationError("Couldn't read the thread.", { cause })),
      );

    const catalog = makeCatalog({
      store,
      newId,
      changed,
      requireAutomation,
      relayHookBaseUrl: ingress.hookBaseUrl,
      compile: compiler.compile,
      watching: sources.statusOf,
    });
    const builtIns = makeBuiltIns({
      store,
      hosts,
      catalog,
      compile: compiler.compile,
      changed,
      requireAutomation,
    });
    const waits = makeWaits({
      store,
      threads,
      links,
      attachments,
      newId,
      start: (input) => startRun({ ...input, trigger: "manual" }),
      callback: (runId, hookId) => ingress.createCallback(runId, hookId),
      cancel: (runId) => endRunById(runId, { status: "cancelled" }),
    });

    const internals: EngineInternals = {
      store,
      links,
      threads,
      services,
      functions,
      runLogs,
      runWaits,
      attachments,
      events,
      notices,
      scope,
      startStep,
      changed,
      runChanged,
      announce,
      complete,
      endRun,
      endRunById,
      launchRun,
      restart,
      automationOfRun,
      ignoreFailure,
    };
    const built = yield* makeDriver(internals);
    driver = built;

    const feed = yield* makeLiveFeed(changes);
    yield* forkRoot(events.worker);

    // Thread-backed steps finish when their thread's run ends. Settling reads the thread, so it
    // runs off the domain event stream, which event triggers match against too.
    const settles = yield* Queue.unbounded<string>();
    yield* forkRoot(
      Queue.take(settles).pipe(
        Effect.flatMap((threadId) =>
          store.stepForThread(threadId).pipe(
            Effect.flatMap((step) => (step ? built.settleThreadStep(step) : Effect.void)),
            logFailure("Automation step couldn't settle"),
            Effect.ensuring(built.adjustBusy(-1)),
          ),
        ),
        Effect.forever,
      ),
    );
    yield* forkRoot(
      Stream.runForEach(threads.domainEvents, (event) =>
        events
          .offer(event)
          .pipe(
            Effect.andThen(
              attachments.onDomainEvent(event).pipe(logFailure("Automation detach failed")),
            ),
            Effect.andThen(
              event.type === "run.updated" && isTerminalRunStatus(event.payload.status)
                ? built
                    .adjustBusy(1)
                    .pipe(Effect.andThen(Queue.offer(settles, event.threadId)), Effect.asVoid)
                : Effect.void,
            ),
          ),
      ),
    );

    // Attached runs' monitors come back after a restart (the driver recovers its own runs).
    yield* forkRoot(attachments.recover.pipe(logFailure("Automation recovery failed")));

    return {
      ...catalog,
      // A built-in's host row changes only with the code.
      save: (input, authorize) =>
        builtIns.guardSave(input).pipe(Effect.andThen(catalog.save(input, authorize))),
      remove,
      startRun,
      builtIns: Effect.sync(() => BUILT_IN_AUTOMATIONS.map(builtInSummary)),
      customize: builtIns.customize,
      cancelAttached: attachments.cancelAttached,
      startWait: waits.start,
      listWaits: waits.list,
      stopWait: waits.stop,
      watchPullRequest: waits.watchPullRequest,
      requestMerge: waits.requestMerge,
      registerBuiltinTools: builtinTools.register,
      registerPullRequestReads: (reads) =>
        Effect.sync(() => {
          pullRequestReads = reads;
        }),
      setWebhookSecret,
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
      // One failing doesn't hold up the other.
      tick: built.tick.pipe(Effect.ensuring(sources.tick)),
      drain: built.drain,
    } satisfies WorkflowEngineShape;
  });

/**
 * The engine replaying runs in QuickJS, on the host services in host.ts; each
 * host provides them (the server's: serverHost.ts).
 */
export const layer = Layer.effect(WorkflowEngine, makeEngine(makeReplayDriver));
