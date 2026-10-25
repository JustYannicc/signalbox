import {
  CommandId,
  ProjectId,
  resolveAutomationAskAnswer,
  ThreadId,
  WorkflowMeta,
  type Automation,
  type AutomationAskAnswerInput,
  type AutomationBuiltIn,
  type AutomationDefaults,
  type AutomationDetail,
  type AutomationError,
  type AutomationNotice,
  type AutomationRunDetail,
  type AutomationRunAttach,
  type AutomationRunSummary,
  type AutomationRunTrigger,
} from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskAnswerCommand } from "@t3tools/contracts/signalboxAsks";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  TaskLifecycleInput as TaskLifecycleInputSchema,
  TaskLifecycleResult as TaskLifecycleResultSchema,
  type TaskLifecycleInput,
  type TaskLifecycleResult,
} from "@t3tools/contracts/taskLifecycle";
import { makeTaskRecords } from "./taskLifecycle.ts";
import { makeTaskLifecycleActions } from "./taskLifecycleActions.ts";
import { makeTaskLifecycleRuns } from "./taskLifecycleRuns.ts";

import { makeAttachments } from "./attachments.ts";
import { makeAsks, type AutomationAnswerContext } from "./asks.ts";
import { decodeWorkflowInput, decodeWorkflowOutput } from "./blockContracts.ts";
import { childSettlement, makeChildRuns } from "./childRuns.ts";
import { makeBuiltinTools, type BuiltinToolHandler } from "./builtinTools/runner.ts";
import { makeExternalRuns, type ExternalRuns } from "./external.ts";
import { AutomationFolders } from "./folderScope.ts";
import { makeCatalog, type AuthorizeAutomation, type CatalogShape } from "./catalog.ts";
import { automationDefaults, errorDetailOf, runLogLines, stepAsk } from "./columns.ts";
import { makeConnections } from "./connections.ts";
import type {
  EndRun,
  EngineServices,
  Launch,
  LaunchRun,
  RunOutcome,
  Settlement,
} from "./engineTypes.ts";
import { automationError, fail, logFailure } from "./errors.ts";
import { makeBuiltIns, type BuiltInPlace } from "./defaults/builtIns.ts";
import * as HostStore from "./defaults/hostStore.ts";
import { BUILT_IN_AUTOMATIONS, builtInSummary } from "./defaults/registry.ts";
import { type ExternalEvent, makeEventTriggers } from "./events/eventTriggers.ts";
import { makePullRequestTracker } from "./events/pullRequestFacts.ts";
import type { PullRequestReads } from "./events/pullRequestDetails.ts";
import { makeRunWaits, stepWatch } from "./events/runWaits.ts";
import {
  AutomationCompiler,
  AutomationFunctions,
  AutomationIngress,
  AutomationModels,
  AutomationModelSteps,
  AutomationThreads,
  forkRoot,
} from "./host.ts";
import { asRecord, fromJson, toJson } from "./json.ts";
import { automationShows, listShows, makeLiveFeed, runShows, type Change } from "./liveFeed.ts";
import { automationNotice, failureNotice } from "./notices.ts";
import { makeRestart } from "./restart.ts";
import * as RunLinkStore from "./runLinkStore.ts";
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

const decodeTaskLifecycle = Schema.decodeUnknownEffect(TaskLifecycleInputSchema);
const encodeTaskLifecycleResult = Schema.encodeSync(Schema.toCodecJson(TaskLifecycleResultSchema));
const decodeWorkflowMeta = Schema.decodeUnknownEffect(WorkflowMeta);

type Store = WorkflowStore.WorkflowStore;

export type { AuthorizeAutomation, ExternalEvent };

export interface WorkflowEngineShape extends CatalogShape {
  readonly taskLifecycle: (
    input: TaskLifecycleInput,
  ) => Effect.Effect<TaskLifecycleResult, AutomationError>;
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
    readonly originThreadId?: string | undefined;
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
  /** A host that reaches another system's runners lets `w.run(…, { on })` send functions there. */
  readonly registerExternalRunner: ExternalRuns["register"];
  /** When `tick` next has recovery or external-run work, for a host that sleeps until then. */
  readonly nextExternalPollAt: ExternalRuns["nextPollAt"];
  /** Sets or clears (null) the webhook signing secret; it is never read back. */
  readonly setWebhookSecret: <E = never>(input: {
    readonly automationId: string;
    readonly secret: string | null;
    readonly authorize?: AuthorizeAutomation<E>;
  }) => Effect.Effect<Automation, AutomationError | E>;
  /** Ends a run now: interrupts its agents, requests and processes, and cancels runs it started. */
  readonly cancelRun: (runId: string) => Effect.Effect<void, AutomationError>;
  /** Starts a new run linked to the failed or cancelled run it retries. */
  readonly retryRun: RetryRun;
  /** Answers a waiting `ask` step, checked against its options and fields. Only people answer; agents can't. */
  readonly answer: (
    input: {
      readonly runId: string;
      readonly stepKey: string;
    } & AutomationAskAnswerInput &
      AutomationAnswerContext,
  ) => Effect.Effect<void, AutomationError>;
  readonly answerSignalboxAsk: (
    command: typeof SignalboxAskAnswerCommand.Type,
    ask: SignalboxAsk,
  ) => Effect.Effect<void, AutomationError>;
  readonly nextAskSyncAt: Effect.Effect<number | null, AutomationError>;
  /** Delivers an event to every running `waitFor` step waiting on it; returns how many it woke. */
  readonly emit: (input: {
    readonly event: string;
    readonly payload?: unknown;
  }) => Effect.Effect<number, AutomationError>;
  /**
   * An event from outside the engine's threads (a cloud drive's change):
   * starts the automations it triggers and wakes runs waiting on it, as a
   * domain event would.
   */
  readonly deliverEvent: (event: ExternalEvent) => Effect.Effect<void, AutomationError>;
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
   * Due crons and hourly cleanup. One bad item never blocks the rest.
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
    const children = yield* makeChildRuns;
    const folders = yield* Effect.serviceOption(AutomationFolders);
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
    const asks = makeAsks({
      store,
      links,
      threads,
      complete: (...args) => complete(...args),
      runChanged: (...args) => runChanged(...args),
    });
    const taskRecords = yield* makeTaskRecords;
    const taskActions = makeTaskLifecycleActions({ threads, records: taskRecords });
    // Steps run in forked fibers; they get the services they use from here.
    const required = yield* Effect.context<EngineServices>();
    // The host's models, when it has a catalog, tell agent steps each model's option names.
    const models = yield* Effect.serviceOption(AutomationModels);
    const modelSteps = yield* Effect.serviceOption(AutomationModelSteps);
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
        runWaits.deliver(envelope, [
          { runId, projectId: envelope.projectId, patterns: ["hook.called"] },
        ]),
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
        if (step.verb === "ask") yield* asks.open(automation, step).pipe(ignoreFailure("ask sync"));
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
    const complete = (
      runId: string,
      key: string,
      outcome: Settlement,
      context?: AutomationAnswerContext,
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const result = yield* store.withTransaction(
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
              now,
            );
            if (!settled) return undefined;
            const ask =
              settled.verb === "ask"
                ? yield* asks.settled(settled, now, context, outcome.ok ? outcome.value : undefined)
                : undefined;
            if (context?.command)
              yield* store.keepAskReceipt(runId, key, context.command.commandId);
            return { settled, ask };
          }),
        );
        if (!result) return false;
        const { settled, ask } = result;
        if (ask) yield* asks.sync(settled, ask).pipe(ignoreFailure("ask sync"));
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

    const external = makeExternalRuns({ store, complete, runChanged, automationOfRun });

    const startStep = makeStartStep({
      store,
      links,
      services,
      functions,
      models: Option.getOrUndefined(modelSteps),
      external,
      connections,
      builtinTools,
      callback: (runId) => ingress.createCallback(runId),
      projects: (projectId) =>
        Option.isSome(folders) ? folders.value.projects(projectId) : Effect.succeed([projectId]),
      existingChild: (step) =>
        Effect.gen(function* () {
          const link = yield* children.get(step.run_id, step.step_key, step.attempt);
          return link
            ? { runId: link.child_run_id, run: yield* store.getRun(link.child_run_id) }
            : undefined;
        }),
      resolveBuiltIn: (name, automation) =>
        builtIns.resolveName(name, {
          projectId: automation.project_id,
          defaults: automationDefaults(automation),
        }),
      launchChild: ({ automation, input, parent, step, wait }) =>
        launchRun({
          automation,
          input,
          trigger: "automation",
          parent,
          claim: (childRunId) =>
            Effect.gen(function* () {
              const prior = yield* children.get(parent.run_id, step.step_key, step.attempt);
              if (prior) return prior.child_run_id;
              const current = yield* store.getRun(parent.run_id);
              if (current?.status !== "running")
                return yield* fail("The parent run already ended.");
              yield* children.claim({
                parent_run_id: parent.run_id,
                step_key: step.step_key,
                attempt: step.attempt,
                child_run_id: childRunId,
                wait: wait ? 1 : 0,
              });
              return undefined;
            }),
        }).pipe(Effect.map(({ run }) => run)),
    });

    const settleChild = (runId: string) =>
      Effect.gen(function* () {
        const link = yield* children.parent(runId);
        if (!link || link.wait !== 1) return;
        if ((yield* store.getRunMeta(link.parent_run_id))?.status !== "running") return;
        const step = yield* store.getStep(link.parent_run_id, link.step_key);
        if (!step || step.attempt !== link.attempt) return;
        const child = yield* store.getRun(runId);
        const outcome = child ? childSettlement(child) : undefined;
        if (!outcome || link.parent_notified === 1) return;
        if (yield* complete(link.parent_run_id, link.step_key, outcome)) {
          yield* children.notified(link);
          return;
        }
        const settled = yield* store.getStep(link.parent_run_id, link.step_key);
        if (settled?.status === "succeeded") {
          yield* theDriver().settled(link.parent_run_id, link.step_key, {
            ok: true,
            value: fromJson(settled.result_json),
          });
          yield* children.notified(link);
        } else if (settled?.status === "failed") {
          yield* theDriver().settled(link.parent_run_id, link.step_key, {
            ok: false,
            error: settled.error ?? "The step failed.",
            detail: errorDetailOf(settled.error_detail_json),
          });
          yield* children.notified(link);
        }
      });
    const recoverChildren = Effect.gen(function* () {
      for (const link of yield* children.pending()) yield* settleChild(link.child_run_id);
    });

    const contractFor = (automationId: string, version: number) =>
      Effect.gen(function* () {
        const metaJson = yield* store.getVersionMeta(automationId, version);
        return yield* decodeWorkflowMeta(
          metaJson ? fromJson(metaJson) : { name: "Automation" },
        ).pipe(
          Effect.mapError((cause) =>
            automationError("Couldn't load the automation's contract.", { cause }),
          ),
        );
      });
    /**
     * Ends a running run once, and everything still working for it: step
     * fibers, agent threads, open steps, and on cancel the runs it started.
     * False when it had already ended. The run's `logs_json` is what its event
     * records, so a replay passes the lines it just saved.
     */
    const endRun: EndRun = (run, candidate, continuation) =>
      Effect.gen(function* () {
        let outcome = candidate;
        if (outcome.status === "succeeded" && outcome.restartedAs === undefined) {
          const meta = yield* contractFor(run.automation_id, run.version);
          const decoded = decodeWorkflowOutput(meta, outcome.output);
          outcome = Result.isSuccess(decoded)
            ? { ...outcome, output: decoded.success }
            : {
                status: "failed",
                error: `Output doesn't match meta.output: ${decoded.failure.message}`,
              };
        }
        const { status } = outcome;
        const steps = yield* store.listSteps(run.run_id);
        const now = yield* DateTime.now;
        const nowText = DateTime.formatIso(now);
        const title = outcome.status === "succeeded" ? runTitle(steps, outcome.output) : null;
        const error = outcome.status === "failed" ? outcome.error : null;
        const detail = outcome.status === "failed" ? (outcome.detail ?? null) : null;
        const ended = yield* store.withTransaction(
          Effect.gen(function* () {
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
            if (ended) {
              if (continuation) yield* continuation;
              if (outcome.status === "succeeded" && outcome.restartedAs)
                yield* children.follow(run.run_id, outcome.restartedAs);
            }
            return ended;
          }),
        );
        if (!ended) return false;
        yield* theDriver().ended(run.run_id, status);
        yield* runWaits.ended(run.run_id);
        yield* ingress.runEnded(run.run_id);
        yield* attachments.refresh(run.run_id);
        const automation = yield* store.getAutomation(run.automation_id);
        for (const step of steps) {
          if (!automation || (step.status !== "running" && step.status !== "waiting")) continue;
          if (step.external_json) yield* external.cancel(automation.project_id, step);
          if (step.thread_id === null) continue;
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
        for (const step of steps) {
          if (step.verb !== "ask" || (step.status !== "running" && step.status !== "waiting"))
            continue;
          const ask = yield* asks.settled(step, nowText);
          if (ask) yield* asks.sync(step, ask).pipe(ignoreFailure("ask sync"));
        }
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
        yield* settleChild(run.run_id);
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

    const validateInput = (automationId: string, version: number, input: unknown) =>
      Effect.gen(function* () {
        const meta = yield* contractFor(automationId, version);
        const decoded = decodeWorkflowInput(meta, input ?? null);
        if (Result.isFailure(decoded))
          return yield* fail(`Input doesn't match meta.input: ${decoded.failure.message}`);
        return decoded.success;
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
        const validatedInput = yield* validateInput(
          launch.automation.automation_id,
          launch.version ?? launch.automation.version,
          launch.input,
        );
        const now = yield* DateTime.now;
        const startedAt = DateTime.formatIso(now);
        const row = {
          run_id: launch.runId ?? (yield* newId("run")),
          automation_id: launch.automation.automation_id,
          version: launch.version ?? launch.automation.version,
          status: "running",
          trigger: launch.trigger,
          input_json: toJson(validatedInput),
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
                      ...(launch.originThreadId ? { originThreadId: launch.originThreadId } : {}),
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
        const insert = Effect.gen(function* () {
          if (launch.parent && (yield* store.getRun(launch.parent.run_id))?.status === "cancelled")
            return yield* fail("The parent run was cancelled.");
          yield* store.insertRun(row);
        }).pipe(
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
        if (launch.continues) {
          const ended = yield* endRun(
            launch.continues,
            { status: "succeeded", output: { restartedAs: row.run_id }, restartedAs: row.run_id },
            insert.pipe(Effect.asVoid),
          );
          if (!ended) {
            const previous = yield* store.getRun(launch.continues.run_id);
            const restartedAs = asRecord(fromJson(previous?.output_json ?? null)).restartedAs;
            const existing =
              typeof restartedAs === "string" ? yield* store.getRun(restartedAs) : undefined;
            if (!existing) return yield* fail("The run already ended.");
            return { run: runSummary(existing), duplicate: true };
          }
        } else if (launch.claim) {
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
          originThreadId: input.originThreadId,
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
        const answeredBy =
          input.answeredBy ?? (threads.askAnswerer ? yield* threads.askAnswerer : undefined);
        yield* complete(
          input.runId,
          input.stepKey,
          { ok: true, value: resolved.value },
          { ...input, ...(answeredBy ? { answeredBy } : {}) },
        );
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
    const restart = makeRestart({
      store,
      links,
      newId,
      endRun,
      launchRun,
      validateInput: (automation, input) =>
        validateInput(automation.automation_id, automation.version, input),
    });
    const projectOfThread = (threadId: string) =>
      threads.getThreadShell(ThreadId.make(threadId)).pipe(
        Effect.map((shell) => shell?.projectId),
        Effect.mapError((cause) => automationError("Couldn't read the thread.", { cause })),
      );

    const catalog = makeCatalog({
      store,
      children,
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

    const taskLifecycleRuns = makeTaskLifecycleRuns({
      actions: taskActions,
      records: taskRecords,
      links,
      store,
      threads,
      attachments,
      startRun,
      endRunById: (runId) => endRunById(runId, { status: "cancelled" }),
    });
    const taskLifecycle: WorkflowEngineShape["taskLifecycle"] = taskLifecycleRuns.act;

    const internals: EngineInternals = {
      store,
      links,
      threads,
      services,
      functions,
      external,
      runLogs,
      runWaits,
      attachments,
      events,
      notices,
      scope,
      startStep,
      pruneChildren: children.prune.pipe(Effect.asVoid),
      settleChild,
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
        taskLifecycleRuns.onDomainEvent(event).pipe(
          logFailure("Task reopen record failed"),
          Effect.andThen(
            Effect.gen(function* () {
              if (!BUILT_IN_AUTOMATIONS.some((item) => item.defaultOn?.includes(event.type)))
                return;
              const shell = yield* threads.getThreadShell(event.threadId);
              if (!shell) return;
              yield* builtIns.ensureDefaultsForEvent(event.type, {
                projectId: shell.projectId,
                defaults: {
                  modelSelection: shell.modelSelection,
                  runtimeMode: shell.runtimeMode,
                  interactionMode: shell.interactionMode,
                },
              });
            }).pipe(logFailure("Default automation setup failed")),
          ),
          Effect.andThen(events.offer(event)),
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
    yield* forkRoot(asks.recover.pipe(logFailure("Automation ask recovery failed")));
    yield* forkRoot(recoverChildren.pipe(logFailure("Child automation recovery failed")));
    yield* taskLifecycleRuns.recoverPending.pipe(logFailure("Task completion recovery failed"));

    return {
      ...catalog,
      // A built-in's host row changes only with the code.
      save: (input, authorize, approvedBy, defaultTimezone) =>
        builtIns
          .guardSave(input)
          .pipe(Effect.andThen(catalog.save(input, authorize, approvedBy, defaultTimezone))),
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
      taskLifecycle,
      registerBuiltinTools: (handler) =>
        builtinTools.register({
          ...handler,
          tools: [...handler.tools, "task_lifecycle"],
          call: (call) =>
            call.tool === "task_lifecycle"
              ? Effect.gen(function* () {
                  const input = yield* decodeTaskLifecycle({
                    ...asRecord(call.args),
                    commandId: `automation:${call.requestKey}:lifecycle`,
                    ...(asRecord(call.args).action === "propose" ? { runId: call.runId } : {}),
                  }).pipe(
                    Effect.mapError((cause) =>
                      automationError("Invalid task lifecycle input.", { cause }),
                    ),
                  );
                  if ((yield* projectOfThread(input.threadId)) !== call.projectId)
                    return yield* fail(
                      "Task lifecycle steps only act in their automation's folder.",
                    );
                  return encodeTaskLifecycleResult(yield* taskLifecycle(input));
                })
              : handler.call(call),
        }),
      registerPullRequestReads: (reads) =>
        Effect.sync(() => {
          pullRequestReads = reads;
        }),
      registerExternalRunner: external.register,
      nextExternalPollAt: Effect.all([external.nextPollAt, taskLifecycleRuns.nextRecoveryAt]).pipe(
        Effect.map((times) => {
          const due = times.filter((at) => at !== null);
          return due.length === 0 ? null : Math.min(...due);
        }),
      ),
      setWebhookSecret,
      cancelRun,
      retryRun,
      answer,
      answerSignalboxAsk: asks.answer,
      nextAskSyncAt: store
        .asksToSync()
        .pipe(
          Effect.flatMap((pending) =>
            pending.length
              ? DateTime.now.pipe(Effect.map((now) => now.epochMilliseconds + 30_000))
              : Effect.succeed(null),
          ),
        ),
      emit,
      deliverEvent: events.externalEvent,
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
      tick: asks.recover.pipe(
        Effect.andThen(built.tick),
        Effect.ensuring(recoverChildren.pipe(logFailure("Child automation recovery failed"))),
        Effect.ensuring(sources.tick),
        Effect.ensuring(external.poll),
        Effect.ensuring(
          taskLifecycleRuns.recoverPending.pipe(logFailure("Task completion recovery failed")),
        ),
      ),
      drain: built.drain.pipe(
        Effect.andThen(asks.recover.pipe(logFailure("Automation ask recovery failed"))),
      ),
    } satisfies WorkflowEngineShape;
  });
