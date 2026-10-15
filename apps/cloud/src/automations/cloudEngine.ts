import { AutomationError, ThreadId, type AutomationNotice } from "@t3tools/contracts";
import { ExecutorSettingsStore } from "@signalbox/automations/executorConnection";
import {
  AutomationFunctions,
  AutomationIngress,
  AutomationRunLogSink,
  AutomationThreads,
} from "@signalbox/automations/host";
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
import { AutomationAlarm, CloudAutomations } from "./CloudAutomations.ts";
import { makeCloudBuiltinTools } from "./cloudBuiltinTools.ts";
import * as CloudCompilerModule from "./cloudCompiler.ts";
import * as CloudThreads from "./cloudThreads.ts";
import { callTool, makeCloudTools } from "./cloudTools.ts";

/**
 * The user's automations on their Durable Object (#434): today's engine on
 * the object's SQLite, its clock on the object's alarm, its agents in the
 * user's cloud threads. Hooks, Executor calls and `w.run` aren't here yet;
 * they fail with a clear message instead of hanging.
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
   * Drives the runs this request touched until they park, pushes what they
   * raised, and sets the alarm for what's due next. workerd drops work a
   * returned request left running.
   */
  const settle = Effect.gen(function* () {
    yield* engine.drain;
    for (const notice of yield* Queue.clear(notices)) yield* push.automationNotice(notice);
    yield* alarm.arm(yield* engine.nextWakeAt);
  });

  const storageError = (cause: unknown) =>
    new AutomationError({ message: "Automation storage failed.", cause });

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
        yield* feed.publish(fresh.map((entry) => entry.event));
        yield* settle;
      }).pipe(
        Effect.mapError(storageError),
        Effect.withSpan("CloudAutomations.threadEvents", {
          attributes: { "thread.id": threadId, "events.count": events.length },
        }),
      ),
    tool: (caller, name, input) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(ThreadId.make(caller.threadId));
        if (shell === null)
          return yield* new AutomationError({ message: "The calling thread is gone." });
        const result = yield* callTool(tools, shell, name, input);
        yield* settle;
        return result;
      }),
    wake: engine.tick.pipe(Effect.andThen(settle), Effect.withSpan("CloudAutomations.wake")),
    settle,
  });
});

/** The engine on the user object: give it the object's SQLite, threads, pushes and the sandbox. */
export const layer = Layer.effect(CloudAutomations, make).pipe(
  Layer.provideMerge(WorkflowEngine.layer),
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
