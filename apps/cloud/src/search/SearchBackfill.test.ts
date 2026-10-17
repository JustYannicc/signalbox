import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
import * as UserStore from "../user/UserStore.ts";
import * as SearchBackfill from "./SearchBackfill.ts";
import * as SearchIndex from "./SearchIndex.ts";

const userId = "user_1";
const actor: Actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const at = (millis: number) => DateTime.makeUnsafe(millis);
type SearchProgress = Effect.Success<ReturnType<SearchIndex.SearchIndex["Service"]["progress"]>>;

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
    shell: shell(threadId, ProjectId.make(`project-${id}`), {
      ...(archived ? { archivedAt: at(20) } : {}),
    }),
  };
};

const makeHarness = (options: {
  readonly summaries: ReadonlyArray<ThreadSummary>;
  readonly completeProgress?: ReadonlySet<string>;
  readonly incompleteProgress?: ReadonlySet<string>;
  readonly failFirstBackfill?: string;
}) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    const userServices = cloud.userObject(userId);
    const { store } = yield* Effect.all({ store: UserStore.UserStore }).pipe(
      Effect.provide(userServices),
    );
    yield* store.recordSignIn({ id: userId, email: "person@example.com" });
    yield* store.replaceThreadIndex(options.summaries);

    const attempts: Array<string> = [];
    const alarms: Array<number> = [];
    const delivered = new Set<string>();
    let failurePending = options.failFirstBackfill ?? null;
    const index: SearchIndex.SearchIndex["Service"] = {
      deliver: () => Effect.void,
      query: () => Effect.succeed({ candidates: [], hasMore: false }),
      progress: (_home, threadIds) =>
        Effect.sync(() => {
          const rows: Array<SearchProgress[number]> = [];
          for (const threadId of threadIds) {
            if (options.completeProgress?.has(threadId) || delivered.has(threadId)) {
              rows.push({ threadId, revision: 2, complete: true });
            } else if (options.incompleteProgress?.has(threadId)) {
              rows.push({ threadId, revision: 1, complete: false });
            }
          }
          return rows;
        }),
    };
    const directory: ThreadDirectory.ThreadDirectory["Service"] = {
      forThread: (threadId) =>
        new Proxy(cloud.threadDirectory.forThread(threadId), {
          get(target, property, receiver) {
            if (property === "backfill") {
              return (
                _requestActor: Actor,
              ): Effect.Effect<
                SearchBackfillProgress,
                ThreadNotFoundError | ThreadDirectory.ThreadObjectError
              > => {
                const id = String(threadId);
                attempts.push(id);
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

    const storage = Layer.mergeAll(
      Layer.effect(UserStore.UserStore, UserStore.UserStore),
      Layer.effect(UserContexts.UserContexts, UserContexts.UserContexts),
      Layer.effect(SqlClient.SqlClient, SqlClient.SqlClient),
    ).pipe(Layer.provide(userServices));
    const layer = SearchBackfill.layer.pipe(
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

    return { attempts, alarms, step };
  });

describe("SearchBackfill", () => {
  it.effect(
    "persists eight-thread scan batches, resumes incomplete progress, and skips completed progress",
    () => {
      const ids = Array.from(
        { length: 45 },
        (_, index) => `thread-${String(index).padStart(2, "0")}`,
      );
      const complete = "thread-05";
      const incomplete = "thread-06";
      const archived = "thread-17";

      return Effect.gen(function* () {
        const harness = yield* makeHarness({
          summaries: ids.map((id) => summary(id, id === archived)),
          completeProgress: new Set([complete]),
          incompleteProgress: new Set([incomplete]),
        });

        for (const expected of [7, 15, 23, 31, 39, 44]) {
          yield* harness.step();
          expect(harness.attempts).toHaveLength(expected);
        }
        expect(harness.attempts).toEqual(ids.filter((id) => id !== complete));
        expect(harness.attempts).toContain(incomplete);
        expect(harness.attempts).toContain(archived);
        expect(harness.alarms).toHaveLength(5);
      });
    },
  );

  it.effect("retries the failed thread without advancing the scan cursor", () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `thread-${String(index).padStart(2, "0")}`,
    );

    return Effect.gen(function* () {
      const harness = yield* makeHarness({
        summaries: ids.map((id) => summary(id)),
        failFirstBackfill: "thread-03",
      });

      yield* harness.step();
      expect(harness.attempts).toEqual(["thread-00", "thread-01", "thread-02", "thread-03"]);
      yield* harness.step();
      expect(harness.attempts).toEqual([
        "thread-00",
        "thread-01",
        "thread-02",
        "thread-03",
        "thread-03",
        "thread-04",
        "thread-05",
        "thread-06",
        "thread-07",
      ]);
    });
  });
});
