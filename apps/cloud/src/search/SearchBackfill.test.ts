import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { makeMemoryCloud } from "../testing.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import type {
  Actor,
  SearchBackfillProgress,
  ThreadNotFoundError,
  ThreadSummary,
} from "../thread/ThreadEngine.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserShell from "../user/UserShell.ts";
import * as UserStore from "../user/UserStore.ts";
import * as SearchBackfill from "./SearchBackfill.ts";
import * as SearchBackfillLive from "./SearchBackfillLive.ts";
import * as SearchIndex from "./SearchIndex.ts";

const userId = "user_1";
const at = (millis: number) => DateTime.makeUnsafe(millis);
type BackfillAttempt = { readonly threadId: string; readonly requestKey: string | undefined };

const shell = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: `Thread ${threadId}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make(`run-${threadId}`),
  latestRunCompletedAt: at(10),
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at(0),
  updatedAt: at(10),
  archivedAt: null,
  settledOverride: null,
  settledAt: at(10),
  deletedAt: null,
  ...overrides,
});

const summary = (id: string, archived = false): ThreadSummary => {
  const threadId = ThreadId.make(id);
  return {
    threadId,
    contextId: PERSONAL_CONTEXT_ID,
    revision: 1,
    shell: shell(threadId, ProjectId.make(`project-${id}`), archived ? { archivedAt: at(20) } : {}),
  };
};

const makeHarness = (options: {
  readonly summaries: ReadonlyArray<ThreadSummary>;
  readonly generation?: string;
  readonly disabled?: boolean;
  readonly signedIn?: boolean;
  readonly completeProgress?: ReadonlySet<string>;
  readonly failFirstBackfill?: string;
  readonly failFirstTableInit?: boolean;
}) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    const userServices = cloud.userObject(userId);
    const { store, sql } = yield* Effect.all({
      store: UserStore.UserStore,
      sql: SqlClient.SqlClient,
    }).pipe(Effect.provide(userServices));
    if (options.signedIn !== false)
      yield* store.recordSignIn({ id: userId, email: "person@example.com" });
    yield* store.replaceThreadIndex(options.summaries);

    const attempts: Array<BackfillAttempt> = [];
    const alarms: Array<number> = [];
    let registryReads = 0;
    let progressCalls = 0;
    let initQueryCount = 0;
    let initFailurePending = options.failFirstTableInit ?? false;
    let activeGeneration = options.generation ?? "1";
    let indexDisabled = options.disabled ?? false;
    const delivered = new Set<string>();
    let failurePending = options.failFirstBackfill ?? null;
    const index: SearchIndex.SearchIndex["Service"] = {
      get generation() {
        return activeGeneration;
      },
      get disabled() {
        return indexDisabled;
      },
      deliver: () => Effect.void,
      query: () => Effect.succeed({ candidates: [], hasMore: false }),
      progress: (_home, threadIds) =>
        Effect.sync(() => {
          progressCalls++;
          return threadIds.flatMap((threadId) =>
            options.completeProgress?.has(threadId) || delivered.has(threadId)
              ? [{ threadId, revision: 2, complete: true }]
              : [],
          );
        }),
    };
    const directory: ThreadDirectory.ThreadDirectory["Service"] = {
      forThread: (threadId) =>
        new Proxy(cloud.threadDirectory.forThread(threadId), {
          get(target, property, receiver) {
            if (property === "backfill") {
              return (
                _requestActor: Actor,
                requestKey?: string,
              ): Effect.Effect<
                SearchBackfillProgress,
                ThreadNotFoundError | ThreadDirectory.ThreadObjectError
              > => {
                const id = String(threadId);
                attempts.push({ threadId: id, requestKey });
                if (failurePending === id) {
                  failurePending = null;
                  return Effect.fail(
                    new ThreadDirectory.ThreadObjectError({
                      operation: "backfill",
                      cause: new Error("temporary delivery failure"),
                    }),
                  );
                }
                delivered.add(id);
                return Effect.succeed({ revision: 1, complete: true });
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
    };

    const observedStore: UserStore.UserStore["Service"] = {
      ...store,
      threadIndex: Effect.andThen(
        Effect.sync(() => {
          registryReads++;
        }),
        store.threadIndex,
      ),
    };
    const observedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        const statement = Array.isArray(args[0]) ? args[0].join("") : "";
        if (
          statement.includes("CREATE TABLE IF NOT EXISTS search_backfill_") ||
          statement.includes("CREATE INDEX IF NOT EXISTS search_backfill_requests_") ||
          statement.includes("INSERT INTO search_backfill_registration_cursor")
        )
          initQueryCount++;
        if (
          initFailurePending &&
          statement.includes("CREATE TABLE IF NOT EXISTS search_backfill_state")
        ) {
          initFailurePending = false;
          return Effect.die("temporary search table initialization failure");
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    const storage = Layer.mergeAll(
      Layer.succeed(UserStore.UserStore, observedStore),
      Layer.effect(UserContexts.UserContexts, UserContexts.UserContexts),
      Layer.succeed(SqlClient.SqlClient, observedSql),
    ).pipe(Layer.provide(userServices));
    const layer = SearchBackfillLive.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          storage,
          Layer.succeed(SearchIndex.SearchIndex, index),
          Layer.succeed(ThreadDirectory.ThreadDirectory, directory),
          Layer.succeed(SearchBackfill.SearchBackfillAlarm, {
            by: (time) =>
              Effect.sync(() => {
                alarms.push(time);
              }),
          }),
        ),
      ),
    );
    const step = () =>
      SearchBackfill.SearchBackfill.use((service) => service.step).pipe(
        Effect.provide(Layer.fresh(layer)),
      );
    const ready = () =>
      SearchBackfill.SearchBackfill.use((service) => service.ready).pipe(
        Effect.provide(Layer.fresh(layer)),
      );
    const activation = () =>
      SearchBackfill.SearchBackfill.use((service) => service.activation).pipe(
        Effect.provide(Layer.fresh(layer)),
      );

    return {
      attempts,
      alarms,
      store,
      userServices,
      layer,
      sql: observedSql,
      get initQueryCount() {
        return initQueryCount;
      },
      get progressCalls() {
        return progressCalls;
      },
      get registryReads() {
        return registryReads;
      },
      setGeneration: (generation: string) => {
        activeGeneration = generation;
      },
      setDisabled: (disabled: boolean) => {
        indexDisabled = disabled;
      },
      activation,
      ready,
      step,
      observeThread: (threadId: ThreadId) =>
        SearchBackfill.SearchBackfill.use((service) => service.observeThread(threadId)).pipe(
          Effect.provide(Layer.fresh(layer)),
        ),
      withService: <A, E>(
        use: (service: SearchBackfill.SearchBackfill["Service"]) => Effect.Effect<A, E>,
      ) => SearchBackfill.SearchBackfill.use(use).pipe(Effect.provide(layer)),
    };
  });

describe("SearchBackfill", () => {
  it.effect(
    "persists eight-thread batches, forces source snapshots, and hibernates completed generations",
    () => {
      const ids = Array.from(
        { length: 45 },
        (_, index) => `thread-${String(index).padStart(2, "0")}`,
      );
      const complete = "thread-05";
      const archived = "thread-17";

      return Effect.gen(function* () {
        const harness = yield* makeHarness({
          summaries: ids.map((id) => summary(id, id === archived)),
          completeProgress: new Set([complete]),
        });

        expect(yield* harness.activation()).toBe("search-backfill:user_1:1:1");
        expect(harness.registryReads).toBe(0);
        for (const expected of [8, 16, 24, 32, 40, 45]) {
          yield* harness.step();
          expect(harness.attempts).toHaveLength(expected);
        }
        expect(harness.attempts.map((attempt) => attempt.threadId)).toEqual(ids);
        expect(harness.attempts.map((attempt) => attempt.requestKey)).toEqual(
          Array.from({ length: ids.length }, () => "search-backfill:user_1:1:1"),
        );
        expect(harness.attempts.map((attempt) => attempt.threadId)).toContain(complete);
        expect(harness.attempts.map((attempt) => attempt.threadId)).toContain(archived);
        expect(harness.alarms).toHaveLength(5);
        expect(harness.registryReads).toBe(6);
        expect(harness.progressCalls).toBe(0);

        yield* harness.step();
        expect(harness.attempts).toHaveLength(ids.length);
        expect(harness.registryReads).toBe(6);
        expect(harness.progressCalls).toBe(0);
        expect(harness.alarms).toHaveLength(5);
      });
    },
  );

  it.effect("retries only the failed thread while the scan cursors advance", () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `thread-${String(index).padStart(2, "0")}`,
    );

    return Effect.gen(function* () {
      const harness = yield* makeHarness({
        summaries: ids.map((id) => summary(id)),
        failFirstBackfill: "thread-03",
      });

      expect(yield* harness.activation()).toBe("search-backfill:user_1:1:1");
      yield* harness.step();
      expect(harness.attempts.map((attempt) => attempt.threadId)).toEqual([
        "thread-00",
        "thread-01",
        "thread-02",
        "thread-03",
      ]);
      yield* harness.step();
      expect(harness.attempts.map((attempt) => attempt.threadId)).toEqual([
        "thread-00",
        "thread-01",
        "thread-02",
        "thread-03",
        "thread-03",
        "thread-04",
        "thread-05",
        "thread-06",
        "thread-07",
        "thread-08",
        "thread-09",
        "thread-10",
      ]);
      expect(harness.attempts[3]?.requestKey).toBe("search-backfill:user_1:1:1");
      expect(harness.attempts[4]?.requestKey).toBe("search-backfill:user_1:1:1");
      expect(harness.registryReads).toBe(2);

      yield* harness.step();
      expect(harness.attempts.at(-1)).toEqual({
        threadId: "thread-11",
        requestKey: "search-backfill:user_1:1:1",
      });
      expect(harness.registryReads).toBe(2);
    });
  });

  it.effect(
    "catches a registration after the completed snapshot without rereading the registry",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ summaries: [summary("thread-z")] });
        yield* harness.step();

        expect(harness.registryReads).toBe(1);
        expect(harness.attempts).toEqual([
          { threadId: "thread-z", requestKey: "search-backfill:user_1:1:1" },
        ]);

        const late = summary("thread-a");
        expect(yield* harness.store.recordThreadSummary(late)).not.toBeNull();
        yield* harness.observeThread(late.threadId);
        yield* harness.step();

        expect(harness.attempts.at(-1)).toEqual({
          threadId: "thread-a",
          requestKey: "search-backfill:user_1:1:1",
        });
        expect(harness.registryReads).toBe(1);

        const attempts = [...harness.attempts];
        yield* harness.step();
        expect(harness.attempts).toEqual(attempts);
        expect(harness.registryReads).toBe(1);
      }),
  );

  it.effect("recovers a registration behind the lexical cursor from its rowid", () =>
    Effect.gen(function* () {
      const ids = Array.from(
        { length: 10 },
        (_, index) => `thread-${String(index).padStart(2, "0")}`,
      );
      const harness = yield* makeHarness({ summaries: ids.map((id) => summary(id)) });
      yield* harness.step();

      expect(harness.attempts.map((attempt) => attempt.threadId)).toEqual(ids.slice(0, 8));
      const behindCursor = summary("thread-03a");
      expect(yield* harness.store.recordThreadSummary(behindCursor)).not.toBeNull();
      // No summary observer runs here: the durable membership cursor must recover it.
      yield* harness.step();

      expect(harness.attempts.map((attempt) => attempt.threadId)).toEqual([
        ...ids.slice(0, 8),
        "thread-03a",
        "thread-08",
        "thread-09",
      ]);
      expect(harness.registryReads).toBe(2);
    }),
  );

  it.effect(
    "recovers a thread after the optional shell enqueue fails and the service restarts",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ summaries: [], failFirstTableInit: true });
        const context = yield* Layer.build(harness.userServices);
        const dependencies = Context.omit(SearchBackfill.SearchBackfill)(context);
        const userShell = UserShell.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(harness.layer, Layer.succeedContext(dependencies))),
        );
        const recoveredSummary = summary("thread-recovered");

        yield* UserShell.UserShell.use((service) =>
          service.recordThreadSummary(recoveredSummary),
        ).pipe(Effect.provide(Layer.fresh(userShell)));

        const indexed = yield* harness.store.threadIndex;
        expect(indexed.threads.map((entry) => entry.shell.id)).toEqual(["thread-recovered"]);
        expect(yield* harness.store.threadMembers).toEqual([ThreadId.make("thread-recovered")]);
        expect(harness.attempts).toEqual([]);
        expect(harness.initQueryCount).toBe(1);

        // A new SearchBackfill layer uses the same SQLite store; no summary redelivery is needed.
        yield* harness.step();
        expect(harness.attempts).toEqual([
          { threadId: "thread-recovered", requestKey: "search-backfill:user_1:1:1" },
        ]);
        expect((yield* harness.store.threadIndex).threads).toHaveLength(1);
        expect(harness.initQueryCount).toBe(7);
      }),
  );

  it.effect(
    "retries failed table initialization and caches its first success per service layer",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          summaries: [summary("thread-a")],
          failFirstTableInit: true,
        });

        yield* harness.withService((service) =>
          Effect.gen(function* () {
            const failed = yield* Effect.exit(service.activation);
            expect(Exit.isFailure(failed)).toBe(true);
            expect(harness.initQueryCount).toBe(1);

            expect(yield* service.activation).toBe("search-backfill:user_1:1:1");
            expect(harness.initQueryCount).toBe(7);
            expect(yield* service.ready).toBe(true);
            yield* service.observeThread(ThreadId.make("thread-a"));
            yield* service.observeThread(ThreadId.make("thread-a"));
            expect(yield* service.activation).toBe("search-backfill:user_1:1:1");
            expect(harness.initQueryCount).toBe(7);

            harness.setGeneration("2");
            expect(yield* service.activation).toBe("search-backfill:user_1:2:2");
            expect(harness.initQueryCount).toBe(7);
          }),
        );
      }),
  );

  it.effect(
    "prunes obsolete requests in bounded indexed batches without rereading a completed registry",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ summaries: [summary("thread-z")] });
        const obsoleteKey = "search-backfill:user_1:1:1";
        const countFor = (key: string) =>
          harness.sql<{ readonly request_count: number }>`SELECT COUNT(*) AS request_count
          FROM search_backfill_requests WHERE activation = ${key}`.pipe(
            Effect.map((rows) => rows[0]?.request_count ?? 0),
          );

        yield* harness.withService((service) =>
          Effect.forEach(
            Array.from({ length: 70 }, (_, index) => ThreadId.make(`pending-${index}`)),
            service.observeThread,
          ),
        );
        expect(yield* countFor(obsoleteKey)).toBe(70);

        harness.setGeneration("2");
        const activeKey = "search-backfill:user_1:2:2";
        yield* harness.observeThread(ThreadId.make("thread-current-2"));

        const [olderPlan, newerPlan, pendingPlan] = yield* Effect.all([
          harness.sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT rowid FROM search_backfill_requests WHERE activation < ${activeKey}
          ORDER BY activation, complete, thread_id LIMIT 32`,
          harness.sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT rowid FROM search_backfill_requests WHERE activation > ${activeKey}
          ORDER BY activation, complete, thread_id LIMIT 32`,
          harness.sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
          SELECT thread_id FROM search_backfill_requests
          WHERE activation = ${activeKey} AND complete = 0 ORDER BY thread_id LIMIT 8`,
        ]);
        for (const plan of [olderPlan, newerPlan, pendingPlan]) {
          expect(plan.map((row) => row.detail).join(" ")).toContain(
            "SEARCH search_backfill_requests USING COVERING INDEX search_backfill_requests_activation_complete_thread",
          );
        }

        const alarmsBeforePruning = harness.alarms.length;
        yield* harness.step();
        expect(yield* countFor(obsoleteKey)).toBe(38);
        expect(yield* countFor(activeKey)).toBeGreaterThan(0);
        expect(harness.alarms).toHaveLength(alarmsBeforePruning + 1);

        yield* harness.step();
        expect(yield* countFor(obsoleteKey)).toBe(6);
        expect(harness.alarms).toHaveLength(alarmsBeforePruning + 2);

        yield* harness.step();
        expect(yield* countFor(obsoleteKey)).toBe(0);
        expect(harness.alarms).toHaveLength(alarmsBeforePruning + 2);
        expect(harness.registryReads).toBe(1);

        harness.setGeneration("1");
        const nextKey = "search-backfill:user_1:1:3";
        yield* harness.observeThread(ThreadId.make("thread-current-1"));
        yield* harness.step();

        expect(yield* countFor(activeKey)).toBe(0);
        expect(yield* countFor(nextKey)).toBeGreaterThan(0);
        expect(harness.attempts).toContainEqual({
          threadId: "thread-current-1",
          requestKey: nextKey,
        });
      }),
  );

  it.effect("does not restart a completed snapshot for duplicate summary delivery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ summaries: [summary("thread-a")] });
      yield* harness.step();
      const attempts = [...harness.attempts];
      const alarms = [...harness.alarms];

      expect(yield* harness.store.recordThreadSummary(summary("thread-a"))).toBeNull();
      yield* harness.observeThread(ThreadId.make("thread-a"));
      yield* harness.observeThread(ThreadId.make("thread-a"));
      yield* harness.step();

      expect(harness.attempts).toEqual(attempts);
      expect(harness.registryReads).toBe(1);
      expect(harness.alarms).toEqual(alarms);
    }),
  );

  it.effect("uses the current activation for requests pending across a generation change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ summaries: [summary("thread-z")] });
      yield* harness.step();
      const late = summary("thread-a");
      expect(yield* harness.store.recordThreadSummary(late)).not.toBeNull();
      yield* harness.observeThread(late.threadId);

      harness.setGeneration("2");
      yield* harness.step();

      expect(harness.attempts).toContainEqual({
        threadId: "thread-a",
        requestKey: "search-backfill:user_1:2:2",
      });
      expect(
        harness.attempts.some(
          (attempt) =>
            attempt.requestKey === "search-backfill:user_1:1:1" && attempt.threadId === "thread-a",
        ),
      ).toBe(false);
      expect(harness.registryReads).toBe(2);
    }),
  );

  it.effect("replays 1 to 2 to 1 activations despite retained complete destination progress", () =>
    Effect.gen(function* () {
      const summaries = [summary("thread-a"), summary("thread-b")];
      const harness = yield* makeHarness({
        summaries,
        completeProgress: new Set(summaries.map((entry) => entry.shell.id)),
      });

      expect(yield* harness.activation()).toBe("search-backfill:user_1:1:1");
      yield* harness.step();
      harness.setGeneration("2");
      expect(yield* harness.activation()).toBe("search-backfill:user_1:2:2");
      yield* harness.step();
      harness.setGeneration("1");
      expect(yield* harness.activation()).toBe("search-backfill:user_1:1:3");
      yield* harness.step();

      expect(harness.attempts).toEqual([
        { threadId: "thread-a", requestKey: "search-backfill:user_1:1:1" },
        { threadId: "thread-b", requestKey: "search-backfill:user_1:1:1" },
        { threadId: "thread-a", requestKey: "search-backfill:user_1:2:2" },
        { threadId: "thread-b", requestKey: "search-backfill:user_1:2:2" },
        { threadId: "thread-a", requestKey: "search-backfill:user_1:1:3" },
        { threadId: "thread-b", requestKey: "search-backfill:user_1:1:3" },
      ]);
      expect(harness.registryReads).toBe(3);
      expect(harness.progressCalls).toBe(0);
    }),
  );

  it.effect("does not scan while disabled or after the same generation is reenabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ summaries: [summary("thread-a")], disabled: true });

      expect(yield* harness.activation()).toBeNull();
      expect(yield* harness.ready()).toBe(false);
      yield* harness.step();
      expect(harness.registryReads).toBe(0);
      expect(harness.attempts).toEqual([]);
      expect(harness.alarms).toEqual([]);

      harness.setDisabled(false);
      expect(yield* harness.activation()).toBeNull();
      expect(yield* harness.ready()).toBe(false);
      yield* harness.step();
      expect(harness.registryReads).toBe(0);
      expect(harness.attempts).toEqual([]);
      expect(harness.alarms).toEqual([]);

      harness.setGeneration("2");
      expect(yield* harness.activation()).toBe("search-backfill:user_1:2:2");
      expect(yield* harness.ready()).toBe(true);
      yield* harness.step();
      expect(harness.registryReads).toBe(1);
      expect(harness.attempts).toEqual([
        { threadId: "thread-a", requestKey: "search-backfill:user_1:2:2" },
      ]);
    }),
  );

  it.effect("does not activate a generation before the user profile exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ summaries: [], signedIn: false });

      expect(yield* harness.activation()).toBeNull();
      expect(harness.registryReads).toBe(0);
      expect(yield* harness.ready()).toBe(false);
    }),
  );
});
