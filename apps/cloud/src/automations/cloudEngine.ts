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
import * as UserDrives from "../user/UserDrives.ts";
import * as UserStore from "../user/UserStore.ts";
import { AutomationAlarm, CloudAutomations, type AutomationHostCall } from "./CloudAutomations.ts";
import { makeCloudBuiltinTools } from "./cloudBuiltinTools.ts";
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

/** The last event sequence taken from each thread, so redelivered events are dropped. */
const ensureCursors = SqlClient.SqlClient.use(
  (sql) => sql`
    CREATE TABLE IF NOT EXISTS signalbox_automation_thread_cursors (
      thread_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    )
  `,
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
  const flush = Effect.gen(function* () {
    yield* engine.drain;
    for (const notice of yield* Queue.clear(notices)) yield* push.automationNotice(notice);
    yield* alarm.arm(yield* runs.nextCronAt);
  });

  /** Who the spans are about: the owner, never anything they wrote. */
  const annotateOwner = owner.pipe(
    Effect.flatMap((actor) => Effect.annotateCurrentSpan({ "person.id": actor.userId })),
    Effect.ignore,
  );

  const storageError = (cause: unknown) =>
    new AutomationError({ message: "Automation storage failed.", cause });

  const hostCall = (call: AutomationHostCall): Effect.Effect<unknown, AutomationError> => {
    switch (call.method) {
      case "step":
        return runs.step(call.runId, call.request, call.marks);
      case "settled":
        return runs.settled(call.runId, call.key);
      case "timedOut":
        return runs.timedOut(call.runId, call.key);
      case "failed":
        return runs.failed(call.runId, call.key, call.error);
      case "finish":
        return runs.finish(call.runId, call.end, call.marks);
    }
  };

  return CloudAutomations.of({
    threadEvents: ({ threadId, events }) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM signalbox_automation_thread_cursors WHERE thread_id = ${threadId}
        `;
        const taken = rows[0]?.sequence ?? 0;
        const fresh = events.filter((entry) => entry.sequence > taken);
        const last = fresh.at(-1);
        if (last === undefined) return;
        yield* sql`
          INSERT INTO signalbox_automation_thread_cursors (thread_id, sequence)
          VALUES (${threadId}, ${last.sequence})
          ON CONFLICT (thread_id) DO UPDATE SET sequence = excluded.sequence
        `;
        yield* annotateOwner;
        yield* feed.publish(fresh.map((entry) => entry.event));
        yield* flush;
      }).pipe(
        Effect.mapError(storageError),
        Effect.withSpan("CloudAutomations.threadEvents", {
          attributes: { "thread.id": threadId, "events.count": events.length },
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
    host: (call) =>
      Effect.gen(function* () {
        const run = yield* runs.runOf(call.runId);
        if (run?.automationId !== call.automationId || run.version !== call.version)
          return yield* new AutomationError({ message: "That run isn't this version's." });
        yield* annotateOwner;
        yield* Effect.annotateCurrentSpan({ "folder.id": run.projectId });
        // A step that failed to start may still have started work (a thread, a notice).
        return yield* hostCall(call).pipe(
          Effect.ensuring(flush.pipe(Effect.catchCause(Effect.logWarning))),
        );
      }).pipe(
        Effect.withSpan("CloudAutomations.host", {
          attributes: {
            "automation.id": call.automationId,
            "automation.version": call.version,
            "automation.run_id": call.runId,
            "automation.host_call": call.method,
          },
        }),
      ),
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
    wake: annotateOwner.pipe(
      Effect.andThen(engine.tick),
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
