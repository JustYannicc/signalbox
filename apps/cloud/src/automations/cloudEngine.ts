import {
  AutomationError,
  CommandId,
  ProjectId,
  ThreadId,
  type AutomationNotice,
} from "@t3tools/contracts";
import { ExecutorSettingsStore } from "@signalbox/automations/executorConnection";
import { AutomationFolders } from "@signalbox/automations/folderScope";
import { explained } from "@signalbox/automations/runLog";
import {
  AutomationFunctions,
  AutomationRunLogSink,
  AutomationThreads,
} from "@signalbox/automations/host";
import * as HostedEngine from "@signalbox/automations/runner/layer";
import { HostedRuns } from "@signalbox/automations/runner/hostedDriver";
import * as RunLinkStore from "@signalbox/automations/runLinkStore";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as PullRequestMergesModule from "../github/PullRequestMerges.ts";
import * as PullRequestReadsModule from "../github/PullRequestReads.ts";
import * as GitHubWebhooksModule from "../github/GitHubWebhooks.ts";
import { PushNotifier } from "../push/PushNotifier.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import { contextOfProject, projectOfDrive } from "../user/contextProjects.ts";
import { folderOfProject } from "../user/folderTree.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserStore from "../user/UserStore.ts";
import * as UserTimezone from "../user/UserTimezone.ts";
import {
  AutomationAlarm,
  CloudAutomations,
  type AutomationHostCall,
  type AutomationHostRequest,
} from "./CloudAutomations.ts";
import { makeCloudBuiltinTools } from "./cloudBuiltinTools.ts";
import { defaultsForSave } from "./automationDefaults.ts";
import { driveEvent, makeChangedFiles } from "./driveChanges.ts";
import * as CloudCompilerModule from "./cloudCompiler.ts";
import * as CloudModelSteps from "./cloudModelSteps.ts";
import * as CloudThreads from "./cloudThreads.ts";
import {
  ensureCloudPullRequestWatches,
  makeCloudPullRequestWatches,
} from "./cloudPullRequestWatches.ts";
import { callTool, makeCloudTools } from "./cloudTools.ts";
import { makeGitHubActionsRunner } from "./githubActionsRunner.ts";
import * as CloudIngress from "./cloudIngress.ts";
import * as HookStoreModule from "./hookStore.ts";
import { threadPullRequestKeysEqual } from "@t3tools/shared/threadPullRequests";

/**
 * The user's automations on their Durable Object (#434). Each run is a
 * Cloudflare Workflow instance running its version as a Dynamic Worker
 * (`automationWorkflow.ts`); Cloudflare journals, replays, sleeps and waits.
 * The object keeps the engine's records on its SQLite, starts steps when an
 * instance asks, runs agents in the user's cloud threads, and sends a waiting
 * step's outcome to its instance as an event. Its alarm starts crons and
 * reads steps' runs on GitHub Actions. Executor calls and `w.run` on
 * the host aren't here yet; they fail with a clear message instead of hanging.
 */

const unavailable = (what: string) =>
  Effect.fail(
    new AutomationError({ message: `${what} aren't available in cloud automations yet.` }),
  );

/** What the cloud doesn't host yet, refusing clearly. */
const layerUnhosted = Layer.mergeAll(
  Layer.succeed(
    AutomationFunctions,
    AutomationFunctions.of({
      run: () =>
        Effect.fail(
          explained("w.run can't run functions on Signalbox Cloud's servers yet.", {
            fix: 'Run it on the folder repository\'s CI instead: w.run(label, { on: "github-actions" }, fn, ...args).',
          }),
        ),
      remove: () => Effect.void,
      prune: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ExecutorSettingsStore,
    ExecutorSettingsStore.of({
      read: Effect.succeed(Option.none()),
      write: () => unavailable("Executor connections"),
      clear: Effect.void,
    }),
  ),
  // Runs' wide events stay out of Workers logs: they hold the code's console lines.
  Layer.succeed(AutomationRunLogSink, AutomationRunLogSink.of({ drain: null, pretty: false })),
);

/** The last event sequence taken from each thread and drive, so redelivered events are dropped. */
const CURSORS = {
  thread: { table: "signalbox_automation_thread_cursors", key: "thread_id" },
  drive: { table: "signalbox_automation_drive_cursors", key: "drive_id" },
} as const;

const ensureCursors = SqlClient.SqlClient.use((sql) =>
  Effect.forEach(
    Object.values(CURSORS),
    ({ table, key }) => sql`
      CREATE TABLE IF NOT EXISTS ${sql(table)} (
        ${sql(key)} TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL
      )
    `,
  ),
);

const make = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const runs = yield* HostedRuns;
  const threads = yield* AutomationThreads;
  const feed = yield* CloudThreads.ThreadEventFeed;
  const compiler = yield* CloudCompilerModule.CloudCompiler;
  const service = yield* CloudThreadService.CloudThreadService;
  const userTimezone = yield* UserTimezone.UserTimezone;
  const savedTimezone = userTimezone.timezone.pipe(
    Effect.mapError(
      (cause) => new AutomationError({ message: "Couldn't read your saved timezone.", cause }),
    ),
  );
  const push = yield* PushNotifier;
  const sql = yield* SqlClient.SqlClient;
  const runLinks = yield* RunLinkStore.make;
  const crypto = yield* Crypto.Crypto;
  const alarm = yield* AutomationAlarm;
  const hooks = yield* CloudIngress.CloudHooks;
  const inbox = yield* HookStoreModule.HookStore;
  const githubHooks = yield* GitHubWebhooksModule.GitHubWebhooks;
  const owner = CloudThreads.ownerActor.pipe(
    Effect.provideService(UserStore.UserStore, yield* UserStore.UserStore),
    Effect.provideService(UserDrives.UserDrives, yield* UserDrives.UserDrives),
  );

  yield* ensureCursors.pipe(Effect.orDie);
  yield* ensureCloudPullRequestWatches.pipe(Effect.orDie);
  const watchRetryAt = yield* Ref.make<number | null>(null);
  const merges = yield* PullRequestMergesModule.PullRequestMerges;
  const changedFiles = yield* makeChangedFiles;
  const folders = yield* UserFolders.UserFolders;
  const pullRequestWatches = yield* makeCloudPullRequestWatches({
    engine,
    threads,
    runningAttached: runLinks.runningAttached,
    clearWatch: (threadId, target, startedAt) =>
      Effect.gen(function* () {
        const actor = yield* owner;
        yield* service
          .syncAutomationPullRequestWatch(
            actor,
            ThreadId.make(threadId),
            { host: target.host, repository: target.repository, number: target.number },
            startedAt,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new AutomationError({
                  message: "Couldn't clear an ended pull request watch.",
                  cause,
                }),
            ),
          );
      }),
    sql,
  });
  yield* engine.registerBuiltinTools(
    makeCloudBuiltinTools({ threads, service, owner, merges, folders }),
  );
  yield* engine.registerPullRequestReads(yield* PullRequestReadsModule.PullRequestReads);
  yield* engine.registerExternalRunner("github-actions", yield* makeGitHubActionsRunner);
  const tools = makeCloudTools({
    engine,
    recordWatch: (caller, target, watching) =>
      Effect.gen(function* () {
        const linked = (caller.pullRequests ?? []).some(
          (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
        );
        const uuid = yield* crypto.randomUUIDv4();
        yield* service.dispatchCommand(yield* owner, {
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`cloud:pr-watch:${uuid}`),
          threadId: caller.id,
          ...target,
          watching,
          ...(watching && !linked ? { link: { url: target.url, source: "agent" } } : {}),
        });
        return yield* pullRequestWatches.reconcile(caller.id, { target, watching });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AutomationError({ message: "Couldn't update the pull request watch.", cause }),
        ),
      ),
    compiler,
    timezone: savedTimezone,
    threads,
    folders,
    github: githubHooks,
  });

  // Notices queue up while the engine works and go out before the request ends.
  const notices = yield* Queue.unbounded<AutomationNotice>();
  yield* Stream.runForEach(Stream.unwrap(engine.subscribeNotices), (notice) =>
    Queue.offer(notices, notice),
  ).pipe(Effect.forkScoped);

  /**
   * Waits for the work this request started here, pushes what it raised, and
   * sets the alarm for the next cron. workerd drops work a returned request
   * left running.
   */
  const drainAndPush = Effect.gen(function* () {
    yield* engine.drain;
    const retryPendingWatches = yield* pullRequestWatches.resumePending().pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Pending pull request watch recovery failed", { cause });
          return true;
        }),
      ),
    );
    const retryWatchCleanup = yield* pullRequestWatches.reconcileEnded().pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Pull request watch cleanup failed", { cause });
          return true;
        }),
      ),
    );
    yield* Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.set(watchRetryAt, retryPendingWatches || retryWatchCleanup ? now + 60_000 : null),
      ),
    );
    for (const notice of yield* Queue.clear(notices)) yield* push.automationNotice(notice);
  });
  /** The next scheduled work, including outcome delivery, ask sync and external runs. */
  const nextAlarmAt = Effect.all([
    runs.nextCronAt,
    runs.nextRedeliveryAt,
    engine.nextAskSyncAt,
    engine.nextExternalPollAt,
    inbox.nextAt,
    githubHooks.nextAt,
    Ref.get(watchRetryAt),
  ]).pipe(
    Effect.map((times) => {
      const pending = times.filter((at): at is number => at !== null);
      return pending.length ? Math.min(...pending) : null;
    }),
  );
  const reconcileGitHubHooks = githubHooks.reconcile.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("GitHub event subscription reconciliation failed", {
          cause: error,
        });
        yield* Clock.currentTimeMillis.pipe(Effect.flatMap((now) => alarm.arm(now + 60_000)));
      }),
    ),
  );
  const flush = drainAndPush.pipe(
    Effect.andThen(reconcileGitHubHooks),
    Effect.andThen(nextAlarmAt),
    Effect.flatMap(alarm.arm),
    Effect.tapCause((cause) => Effect.logError("Cloud automations flush failed", cause)),
  );

  /** Who the spans are about: the owner, never anything they wrote. The id never changes, so it's read once. */
  let ownerId: string | undefined;
  const annotateOwner = Effect.suspend(() =>
    ownerId === undefined
      ? owner.pipe(Effect.tap((actor) => Effect.sync(() => (ownerId = actor.userId))))
      : Effect.succeed({ userId: ownerId }),
  ).pipe(
    Effect.flatMap((actor) => Effect.annotateCurrentSpan({ "person.id": actor.userId })),
    Effect.ignore,
  );

  /** What of `events` is new since the last one taken from `id`, and marking it taken. */
  const freshSince = <A extends { readonly sequence: number }>(
    source: keyof typeof CURSORS,
    id: string,
    events: ReadonlyArray<A>,
  ) =>
    Effect.gen(function* () {
      const { table, key } = CURSORS[source];
      const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM ${sql(table)} WHERE ${sql(key)} = ${id}
      `;
      const taken = rows[0]?.sequence ?? 0;
      const fresh = events.filter((entry) => entry.sequence > taken);
      const last = fresh.reduce((latest, entry) => Math.max(latest, entry.sequence), taken);
      const take = sql`
        INSERT INTO ${sql(table)} (${sql(key)}, sequence) VALUES (${id}, ${last})
        ON CONFLICT (${sql(key)}) DO UPDATE SET sequence = excluded.sequence
      `.pipe(Effect.asVoid);
      return { fresh, take };
    });

  const storageError = (cause: unknown) =>
    new AutomationError({ message: "Automation storage failed.", cause });

  /** `AutomationRunHost`'s methods on the engine's handlers. */
  const handlers: {
    readonly [M in AutomationHostRequest["method"]]: (
      ...args: Extract<AutomationHostRequest, { readonly method: M }>["args"]
    ) => Effect.Effect<unknown, AutomationError>;
  } = {
    step: runs.step,
    settled: (runId, key) => runs.settled(runId, key),
    timedOut: runs.timedOut,
    failed: runs.failed,
    finish: runs.finish,
  };
  const hostCall = (call: AutomationHostCall) =>
    (
      handlers[call.method] as (
        ...args: ReadonlyArray<unknown>
      ) => Effect.Effect<unknown, AutomationError>
    )(...call.args);

  return CloudAutomations.of({
    answerAsk: (command, ask) =>
      engine.answerSignalboxAsk(command, ask).pipe(Effect.andThen(flush)),
    save: (input, newThreadModel) =>
      Effect.gen(function* () {
        if (input.compiled === undefined) {
          return yield* new AutomationError({ message: CloudCompilerModule.COMPILE_WHERE });
        }
        const compiled = yield* CloudCompilerModule.acceptCompiled(input.compiled);
        const defaultTimezone =
          compiled.meta.triggers?.some(
            (trigger) => "cron" in trigger && trigger.timezone === undefined,
          ) === true
            ? yield* savedTimezone
            : undefined;
        const defaults = yield* defaultsForSave({
          engine,
          projectId: input.projectId,
          ...(input.automationId ? { automationId: input.automationId } : {}),
          name: compiled.meta.name,
          graph: compiled.graph,
          newThreadModel,
        });
        return yield* compiler.withStaged(
          input.source,
          compiled,
          engine.save(
            {
              source: input.source,
              projectId: input.projectId,
              defaults,
              ...(input.automationId ? { automationId: input.automationId } : {}),
              ...(input.draft === true ? { draft: true } : {}),
            },
            undefined,
            undefined,
            defaultTimezone,
          ),
        );
      }).pipe(Effect.tap(() => flush)),
    receiveHook: (request) =>
      annotateOwner.pipe(
        Effect.andThen(
          request.token === "" ? githubHooks.receive(request) : hooks.receive(request),
        ),
        Effect.tap(() => nextAlarmAt.pipe(Effect.flatMap(alarm.arm))),
        Effect.withSpan("CloudAutomations.receiveHook", {
          attributes: {
            "webhook.id": request.hookId,
            "webhook.body_bytes": request.body.byteLength,
          },
        }),
      ),
    threadEvents: ({ threadId, events }) =>
      Effect.gen(function* () {
        const { fresh, take } = yield* freshSince("thread", threadId, events);
        if (fresh.length === 0) return;
        yield* annotateOwner;
        // The event body can be stale or arrive after a later command. Re-read the
        // owner's current snapshot before applying watch intent or waking runs.
        yield* pullRequestWatches.reconcile(threadId);
        yield* feed.publish(fresh.map((entry) => entry.event));
        yield* flush;
        // A retry repeats idempotent watch effects and event delivery until both finish.
        yield* take;
      }).pipe(
        Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }),
        Effect.withSpan("CloudAutomations.threadEvents", {
          attributes: { "thread.id": threadId, "events.count": events.length },
        }),
      ),
    driveEvents: ({ driveId, events }) =>
      Effect.gen(function* () {
        const { fresh, take } = yield* freshSince("drive", driveId, events);
        if (fresh.length === 0) return;
        yield* annotateOwner;
        const projectId = projectOfDrive(driveId, (yield* owner).userId);
        if (projectId !== null) {
          for (const move of fresh) {
            yield* engine.deliverEvent(driveEvent(driveId, projectId, move, changedFiles));
          }
          yield* flush;
        }
        // Taken only once handled: a request cut off before here gets them again.
        yield* take;
      }).pipe(
        Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }),
        Effect.withSpan("CloudAutomations.driveEvents", {
          attributes: { "drive.id": driveId, "events.count": events.length },
        }),
      ),
    tool: (caller, name, input) =>
      Effect.gen(function* () {
        yield* annotateOwner;
        const shell = yield* threads.getThreadShell(ThreadId.make(caller.threadId));
        if (shell === null)
          return yield* new AutomationError({ message: "The calling thread is gone." });
        const result = yield* callTool(tools, shell, name, input);
        yield* flush;
        return result;
      }).pipe(
        Effect.withSpan("CloudAutomations.toolCall", {
          attributes: { "thread.id": caller.threadId },
        }),
      ),
    host: (call) => {
      const runId = call.args[0];
      return Effect.gen(function* () {
        const run = yield* runs.runOf(runId);
        if (run?.automationId !== call.automationId || run.version !== call.version)
          return yield* new AutomationError({ message: "That run isn't this version's." });
        yield* annotateOwner;
        // A step that failed to start may still have started work (a thread, a notice).
        // A step on GitHub Actions is read on the alarm, so it's armed for that too.
        return yield* hostCall(call).pipe(
          Effect.ensuring(flush.pipe(Effect.catchCause(Effect.logWarning))),
        );
      }).pipe(
        Effect.withSpan("CloudAutomations.host", {
          attributes: {
            "automation.id": call.automationId,
            "automation.version": call.version,
            "automation.run_id": runId,
            "automation.host_call": call.method,
          },
        }),
      );
    },
    executorRunActive: (input) =>
      Effect.gen(function* () {
        const { run } = yield* engine.getRun(input.runId);
        if (run.status !== "running") return false;
        const { automation } = yield* engine.get(run.automationId);
        const state = yield* folders.state;
        const home = folderOfProject(state.tree, automation.projectId);
        const ownerId =
          (home === null
            ? contextOfProject(state.contexts, automation.projectId)
            : state.tree.folders.find((folder) => folder.id === home)?.ownerId) ?? null;
        return ownerId === input.ownerId && (home ?? ownerId) === input.level;
      }).pipe(Effect.orElseSucceed(() => false)),
    workerModule: (automationId, version) =>
      runs.workerModule(automationId, version).pipe(
        Effect.flatMap((module) =>
          module === undefined
            ? Effect.fail(
                new AutomationError({
                  message: `Version ${version} was saved before the cloud ran automations; save it again.`,
                }),
              )
            : Effect.succeed(module),
        ),
        Effect.withSpan("CloudAutomations.workerModule", {
          attributes: { "automation.id": automationId, "automation.version": version },
        }),
      ),
    start: runs.recover.pipe(
      Effect.andThen(runs.redeliver),
      Effect.andThen(flush),
      Effect.withSpan("CloudAutomations.start"),
    ),
    wake: annotateOwner.pipe(
      Effect.andThen(githubHooks.sync),
      Effect.andThen(
        inbox.drain((row) =>
          row.kind === "github"
            ? githubHooks.deliver(row.target, row.payload, row.id)
            : hooks.deliver(row.kind, row.payload, row.id),
        ),
      ),
      Effect.andThen(engine.tick),
      Effect.andThen(runs.redeliver),
      Effect.andThen(flush),
      Effect.withSpan("CloudAutomations.wake"),
    ),
    flush,
  });
});

/** The engine on the user object: give it the object's SQLite, threads, pushes and its runner. */
const layerAutomationFolders = Layer.effect(
  AutomationFolders,
  Effect.gen(function* () {
    const folders = yield* UserFolders.UserFolders;
    return AutomationFolders.of({
      projects: (projectId) =>
        folders.automationProjects(ProjectId.make(projectId)).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: "Couldn't resolve automation folder scopes.",
                cause,
              }),
          ),
        ),
    });
  }),
);

export const layer = Layer.effect(CloudAutomations, make).pipe(
  Layer.provideMerge(
    GitHubWebhooksModule.layer.pipe(Layer.provideMerge(PullRequestMergesModule.layer)),
  ),
  Layer.provideMerge(HostedEngine.layer.pipe(Layer.provide(layerAutomationFolders))),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudThreads.layer,
      CloudCompilerModule.layer,
      CloudModelSteps.layer,
      PullRequestReadsModule.layer,
      PullRequestMergesModule.layer,
      layerUnhosted,
      CloudIngress.layer,
    ).pipe(Layer.provideMerge(CloudThreads.layerEventFeed)),
  ),
  Layer.provideMerge(HookStoreModule.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
