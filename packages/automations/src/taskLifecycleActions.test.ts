import {
  AutomationError,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { AutomationThreadsShape, ThreadRecordField, ThreadRecords } from "./host.ts";
import { makeTaskLifecycleActions } from "./taskLifecycleActions.ts";
import { makeTaskRecords, type TaskLifecycleRecords } from "./taskLifecycle.ts";

const THREAD_ID = ThreadId.make("thread-lifecycle");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const at = (offset = 0) => DateTime.makeUnsafe(Date.parse("2026-10-17T09:00:00.000Z") + offset);

const threadFixture = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: THREAD_ID,
  projectId: ProjectId.make("project-lifecycle"),
  title: "Task lifecycle test",
  providerInstanceId: PROVIDER_INSTANCE_ID,
  modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "task-branch",
  worktreePath: "/workspace/task",
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: THREAD_ID,
  },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 1,
  visibleItemCount: 1,
  createdBy: "user",
  creationSource: "web",
  createdAt: at(),
  updatedAt: at(),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

const runFixture = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make("run-lifecycle"),
  threadId: THREAD_ID,
  ordinal: 1,
  providerInstanceId: PROVIDER_INSTANCE_ID,
  modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "gpt-6.1-sol" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-lifecycle"),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at(),
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

type LifecycleCommand = Parameters<NonNullable<AutomationThreadsShape["dispatchLifecycle"]>>[0];

interface HarnessOptions {
  readonly kind?: "chat" | "task";
  readonly threadId?: ThreadId;
  readonly thread?: Partial<OrchestrationV2ThreadShell>;
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly staleSettle?: boolean;
  readonly failFirstSettle?: boolean;
  readonly beforeDispatch?: (
    command: LifecycleCommand,
    records: TaskLifecycleRecords,
  ) => Effect.Effect<void, AutomationError>;
}

const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const records = yield* makeTaskRecords;
    const threadId = options.threadId ?? THREAD_ID;
    let thread = threadFixture({ ...options.thread, id: threadId });
    let runs = options.runs ?? [];
    let failFirstSettle = options.failFirstSettle ?? false;
    const dispatches: LifecycleCommand[] = [];
    const recordReads: ReadonlyArray<ThreadRecordField>[] = [];
    const messages: ThreadRecords<"messages">["messages"] = [];

    const threads: AutomationThreadsShape = {
      getThreadShell: () => Effect.succeed(thread),
      getThreadRecords: (_threadId: ThreadId, fields: ReadonlyArray<ThreadRecordField>) => {
        recordReads.push(fields);
        const selected: ThreadRecords<ThreadRecordField> = {
          thread: { ...thread, lastVisitedAt: null },
          runs,
          messages,
          turnItems: [],
        };
        return Effect.succeed(selected);
      },
      launch: () => Effect.succeed({ threadId: ThreadId.make("child-thread") }),
      send: () => Effect.succeed({ run: runFixture("completed") }),
      interrupt: () => Effect.void,
      settle: () => Effect.void,
      dispatchLifecycle: (command) =>
        Effect.gen(function* () {
          dispatches.push(command);
          if (options.beforeDispatch !== undefined) yield* options.beforeDispatch(command, records);
          if (command.type === "thread.settle" && failFirstSettle) {
            failFirstSettle = false;
            return yield* Effect.fail(
              new AutomationError({ message: "Temporary dispatch failure." }),
            );
          }
          if (command.type === "thread.settle") {
            thread = options.staleSettle
              ? { ...thread, updatedAt: at(3) }
              : {
                  ...thread,
                  archivedAt: at(2),
                  settledOverride: "settled",
                  settledAt: at(2),
                  updatedAt: at(2),
                };
          } else if (command.type === "thread.unsettle") {
            thread = {
              ...thread,
              archivedAt: null,
              settledOverride: "active",
              settledAt: null,
              unsettledAt: at(4),
              updatedAt: at(4),
            };
          } else if (command.type === "thread.unarchive") {
            thread = { ...thread, archivedAt: null, updatedAt: at(4) };
          } else if (command.type === "thread.auto-settle.set") {
            thread = {
              ...thread,
              autoSettleDisabledAt: command.enabled ? null : at(1),
              updatedAt: at(1),
            };
          }
        }),
      getTaskKind: () => Effect.succeed(options.kind ?? "task"),
      domainEvents: Stream.empty,
      monitorsChanged: () => Effect.void,
    };

    return {
      actions: makeTaskLifecycleActions({ threads, records }),
      dispatches,
      recordReads,
      records,
      setRuns: (next: ReadonlyArray<OrchestrationV2Run>) => {
        runs = next;
      },
      thread: () => thread,
    };
  });

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("task lifecycle actions", () => {
  it.effect("stores the outcome before settlement and reopens without losing task metadata", () =>
    withDatabase(
      Effect.gen(function* () {
        let outcomeAtDispatch: string | null = null;
        const setup = yield* harness({
          beforeDispatch: (command, records) =>
            command.type === "thread.settle"
              ? records.read(THREAD_ID).pipe(
                  Effect.tap((record) =>
                    Effect.sync(() => {
                      outcomeAtDispatch = record?.outcome ?? null;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        const { actions, dispatches } = setup;
        const proposed = yield* actions.act({
          threadId: THREAD_ID,
          action: "propose",
          summary: "The linked pull request merges",
          automationId: "task-done-condition",
          runId: "run-condition",
          input: { conditions: [{ type: "pull-request.merged", number: 671 }] },
          commandId: "proposal-1",
        });
        expect(proposed.applied).toBe(true);
        expect(proposed.record?.generation).toBe(1);
        expect(proposed.thread.autoSettleDisabledAt).toEqual(at(1));

        const completed = yield* actions.act({
          threadId: THREAD_ID,
          action: "complete",
          outcome: "The pull request merged",
          expectedGeneration: 1,
          expectedUpdatedAt: DateTime.formatIso(proposed.thread.updatedAt),
          commandId: "complete-1",
        });
        expect(outcomeAtDispatch).toBe("The pull request merged");
        expect(completed.applied).toBe(true);
        expect(completed.thread.archivedAt).toEqual(at(2));
        expect(completed.thread.settledOverride).toBe("settled");
        expect(completed.thread.title).toBe("Task lifecycle test");
        expect(completed.thread.branch).toBe("task-branch");
        expect(completed.record?.condition).toEqual(proposed.record?.condition);
        expect(completed.record?.generation).toBe(2);

        const reopened = yield* actions.act({
          threadId: THREAD_ID,
          action: "reopen",
          expectedGeneration: 2,
          commandId: "reopen-1",
        });
        expect(reopened.applied).toBe(true);
        expect(reopened.thread.archivedAt).toBeNull();
        expect(reopened.thread.settledOverride).toBe("active");
        expect(reopened.thread.settledAt).toBeNull();
        expect(reopened.thread.unsettledAt).toEqual(at(4));
        expect(reopened.thread.title).toBe("Task lifecycle test");
        expect(reopened.thread.branch).toBe("task-branch");
        expect(reopened.thread.worktreePath).toBe("/workspace/task");
        expect(reopened.record).toMatchObject({
          condition: proposed.record?.condition,
          outcome: null,
          reason: null,
          settledAt: null,
          generation: 3,
        });
        expect(dispatches.map((command) => command.type)).toEqual([
          "thread.auto-settle.set",
          "thread.settle",
          "thread.unsettle",
        ]);
      }),
    ),
  );

  it.effect("leaves a completion inactive when its generation or thread snapshot is stale", () =>
    withDatabase(
      Effect.gen(function* () {
        const staleGeneration = yield* harness();
        yield* staleGeneration.records.propose({
          threadId: THREAD_ID,
          summary: "Done when CI passes",
        });
        const ignored = yield* staleGeneration.actions.act({
          threadId: THREAD_ID,
          action: "complete",
          outcome: "CI passed",
          expectedGeneration: 0,
        });
        expect(ignored.applied).toBe(false);
        expect(staleGeneration.dispatches).toHaveLength(0);

        const snapshotThreadId = ThreadId.make("thread-stale-snapshot");
        const staleSnapshot = yield* harness({ staleSettle: true, threadId: snapshotThreadId });
        const result = yield* staleSnapshot.actions.act({
          threadId: snapshotThreadId,
          action: "complete",
          outcome: "The date passed",
          expectedGeneration: 0,
          commandId: "complete-stale-snapshot",
        });
        expect(result.applied).toBe(false);
        expect(result.thread.archivedAt).toBeNull();
        expect(result.record).toMatchObject({
          condition: null,
          outcome: null,
          settledAt: null,
          generation: 2,
        });
        expect(staleSnapshot.dispatches.map((command) => command.type)).toEqual(["thread.settle"]);
      }),
    ),
  );

  it.effect("does not settle a working or queued task", () =>
    withDatabase(
      Effect.gen(function* () {
        const setup = yield* harness();
        for (const status of ["running", "queued"] as const) {
          setup.setRuns([runFixture(status)]);
          const result = yield* setup.actions.act({
            threadId: THREAD_ID,
            action: "complete",
            outcome: "Everything is done",
            expectedGeneration: 0,
          });
          expect(result.applied).toBe(false);
          expect(result.thread.archivedAt).toBeNull();
        }
        expect(setup.dispatches).toHaveLength(0);
        expect(yield* setup.records.read(THREAD_ID)).toBeNull();
      }),
    ),
  );

  it.effect("invalidates pending conditions once for each reopen event", () =>
    withDatabase(
      Effect.gen(function* () {
        const setup = yield* harness();
        const appThread = (id: ThreadId): OrchestrationV2AppThread => ({
          ...threadFixture({
            id,
            lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
          }),
          lastVisitedAt: null,
        });
        for (const [type, threadId, id] of [
          ["thread.unsettled", THREAD_ID, "event-unsettled"],
          ["thread.unarchived", ThreadId.make("thread-unarchived"), "event-unarchived"],
        ] as const) {
          const proposed = yield* setup.records.propose({
            threadId,
            summary: `Condition invalidated by ${type}`,
          });
          const event = {
            id: EventId.make(id),
            threadId,
            occurredAt: at(),
            type,
            payload: appThread(threadId),
          } satisfies OrchestrationV2DomainEvent;
          yield* setup.actions.onDomainEvent(event);
          expect(yield* setup.records.read(threadId)).toMatchObject({
            condition: proposed.record?.condition,
            generation: 2,
            settledAt: null,
          });

          yield* setup.actions.onDomainEvent(event);
          expect((yield* setup.records.read(threadId))?.generation).toBe(2);
        }
      }),
    ),
  );

  it.effect("keeps chats free of conditions and reopens an archived chat with unarchive", () =>
    withDatabase(
      Effect.gen(function* () {
        const setup = yield* harness({
          kind: "chat",
          thread: { archivedAt: at(6) },
        });
        const proposalError = yield* Effect.flip(
          setup.actions.act({
            threadId: THREAD_ID,
            action: "propose",
            summary: "Chats have no done-condition",
          }),
        );
        expect(proposalError.message).toContain("Chats have no done-condition");
        expect(yield* setup.records.read(THREAD_ID)).toBeNull();
        expect(setup.dispatches).toHaveLength(0);

        const ordinaryRead = yield* setup.actions.act({ threadId: THREAD_ID, action: "read" });
        expect(ordinaryRead.messages).toEqual([]);
        expect(setup.recordReads).toEqual([["runs"], ["runs"]]);
        const contextualRead = yield* setup.actions.act({
          threadId: THREAD_ID,
          action: "read",
          includeContext: true,
        });
        expect(contextualRead.messages).toEqual([]);
        expect(setup.recordReads).toEqual([["runs"], ["runs"], ["runs"], ["messages"]]);

        const reopened = yield* setup.actions.act({
          threadId: THREAD_ID,
          action: "reopen",
          commandId: "unarchive-chat",
        });
        expect(reopened.applied).toBe(true);
        expect(reopened.thread.archivedAt).toBeNull();
        expect(reopened.thread.title).toBe("Task lifecycle test");
        expect(setup.dispatches.map((command) => command.type)).toEqual(["thread.unarchive"]);
        expect(reopened.record?.generation).toBe(1);
      }),
    ),
  );

  it.effect("retries a stored completion after settlement dispatch fails", () =>
    withDatabase(
      Effect.gen(function* () {
        let outcomeAtDispatch: string | null = null;
        const setup = yield* harness({
          failFirstSettle: true,
          beforeDispatch: (command, records) =>
            command.type === "thread.settle"
              ? records.read(THREAD_ID).pipe(
                  Effect.tap((record) =>
                    Effect.sync(() => {
                      outcomeAtDispatch = record?.outcome ?? null;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        const input = {
          threadId: THREAD_ID,
          action: "complete" as const,
          outcome: "The task is complete",
          expectedGeneration: 0,
          commandId: "retry-completion",
        };
        const error = yield* Effect.flip(setup.actions.act(input));
        expect(error.message).toBe("Temporary dispatch failure.");
        expect(outcomeAtDispatch).toBe("The task is complete");
        expect(yield* setup.records.read(THREAD_ID)).toMatchObject({
          outcome: "The task is complete",
          generation: 1,
        });
        expect(setup.thread().archivedAt).toBeNull();

        const retried = yield* setup.actions.act(input);
        expect(retried.applied).toBe(true);
        expect(retried.thread.archivedAt).toEqual(at(2));
        expect(retried.record).toMatchObject({
          outcome: "The task is complete",
          generation: 1,
        });
        expect(setup.dispatches.map((command) => command.type)).toEqual([
          "thread.settle",
          "thread.settle",
        ]);
      }),
    ),
  );
});
