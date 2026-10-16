import { AutomationError, ThreadId, type AutomationNotice } from "@t3tools/contracts";
import { ExecutorSettingsStore } from "@signalbox/automations/executorConnection";
import {
  AutomationFunctions,
  AutomationIngress,
  AutomationRunLogSink,
  AutomationThreads,
} from "@signalbox/automations/host";
import * as HostedEngine from "@signalbox/automations/runner/layer";
import { HostedRuns } from "@signalbox/automations/runner/hostedDriver";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as PullRequestReadsModule from "../github/PullRequestReads.ts";
import { PushNotifier } from "../push/PushNotifier.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import { projectOfDrive } from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserStore from "../user/UserStore.ts";
import {
  AutomationAlarm,
  CloudAutomations,
  type AutomationHostCall,
  type AutomationHostRequest,
} from "./CloudAutomations.ts";
import { makeCloudBuiltinTools } from "./cloudBuiltinTools.ts";
import { driveEvent, makeChangedFiles } from "./driveChanges.ts";
import * as CloudCompilerModule from "./cloudCompiler.ts";
import * as CloudThreads from "./cloudThreads.ts";
import { callTool, makeCloudTools } from "./cloudTools.ts";

/**
 * The user's automations on their Durable Object (#434). Each run is a
 * Cloudflare Workflow instance running its version as a Dynamic Worker
 * (`automationWorkflow.ts`); Cloudflare journals, replays, sleeps and waits.
 * The object keeps the engine's records on its SQLite, starts steps when an
 * instance asks, runs agents in the user's cloud threads, and sends a waiting
 * step's outcome to its instance as an event. Its alarm only starts crons.
 * Hooks, Executor calls and `w.run` aren't here yet; they fail with a clear
 * message instead of hanging.
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
      run: () => unavailable("w.run functions"),
      remove: () => Effect.void,
      prune: () => Effect.void,
    }),
  ),
  Layer.succeed(
    AutomationIngress,
    AutomationIngress.of({
      make: () =>
        Effect.succeed({
          hookBaseUrl: Effect.succeed(null),
          createCallback: () => unavailable("Callback links (w.hook)"),
          runEnded: () => Effect.void,
          forget: () => Effect.void,
          setSecret: () => unavailable("Webhooks"),
        }),
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
  const push = yield* PushNotifier;
  const sql = yield* SqlClient.SqlClient;
  const alarm = yield* AutomationAlarm;
  const owner = CloudThreads.ownerActor.pipe(
    Effect.provideService(UserStore.UserStore, yield* UserStore.UserStore),
    Effect.provideService(UserDrives.UserDrives, yield* UserDrives.UserDrives),
  );

  yield* ensureCursors.pipe(Effect.orDie);
  const changedFiles = yield* makeChangedFiles;
  yield* engine.registerBuiltinTools(makeCloudBuiltinTools({ threads, service, owner }));
  yield* engine.registerPullRequestReads(yield* PullRequestReadsModule.PullRequestReads);
  const tools = makeCloudTools({ engine, compiler, threads });

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
    for (const notice of yield* Queue.clear(notices)) yield* push.automationNotice(notice);
  });
  /** The alarm goes off for the next cron, or sooner to tell an instance an outcome again. */
  const nextAlarmAt = Effect.all([runs.nextCronAt, runs.nextRedeliveryAt]).pipe(
    Effect.map(([cron, redelivery]) =>
      cron === null ? redelivery : redelivery === null ? cron : Math.min(cron, redelivery),
    ),
  );
  const flush = drainAndPush.pipe(Effect.andThen(nextAlarmAt), Effect.flatMap(alarm.arm));

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
      const last = fresh.at(-1)?.sequence ?? taken;
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
    threadEvents: ({ threadId, events }) =>
      Effect.gen(function* () {
        const { fresh, take } = yield* freshSince("thread", threadId, events);
        if (fresh.length === 0) return;
        yield* take;
        yield* annotateOwner;
        yield* feed.publish(fresh.map((entry) => entry.event));
        yield* flush;
      }).pipe(
        Effect.mapError(storageError),
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
        // Host calls never change crons, so the alarm stays as it is.
        return yield* hostCall(call).pipe(
          Effect.ensuring(drainAndPush.pipe(Effect.catchCause(Effect.logWarning))),
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
      Effect.andThen(engine.tick),
      Effect.andThen(runs.redeliver),
      Effect.andThen(flush),
      Effect.withSpan("CloudAutomations.wake"),
    ),
    flush,
  });
});

/** The engine on the user object: give it the object's SQLite, threads, pushes and its runner. */
export const layer = Layer.effect(CloudAutomations, make).pipe(
  Layer.provideMerge(HostedEngine.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudThreads.layer,
      CloudCompilerModule.layer,
      PullRequestReadsModule.layer,
      layerUnhosted,
    ).pipe(Layer.provideMerge(CloudThreads.layerEventFeed)),
  ),
  Layer.provideMerge(FetchHttpClient.layer),
);
