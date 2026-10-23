import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  type ProviderContinuation,
  type OrchestrationV2DispatchCommandResult,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import { HarnessError } from "../harness/Harness.ts";
import type { HarnessContinuation } from "../harness/HarnessContinuations.ts";
import * as Platform from "../platform.ts";
import { layerAttachments, makeMemoryCloud } from "../testing.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import type { ThreadCreation } from "./ThreadEngine.ts";
import { createHarnessContinuationPublisher } from "./HarnessContinuationPublisher.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { decide } from "./threadDecider.ts";
import type { ThreadCommand } from "./threadCommands.ts";
import * as ThreadKindTurns from "./ThreadKindTurns.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";
import { ThreadContexts } from "../user/threadContexts.ts";
import type { ThreadTurn } from "../user/threadContexts.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("harness-continuation-publisher");
const projectId = ProjectId.make("scratch");

type Authorize = (request: HarnessContinuation) => Effect.Effect<typeof actor, HarnessError>;
type ObservedDispatch = {
  readonly command: ThreadCommand;
  readonly creation: ThreadCreation;
  readonly result: OrchestrationV2DispatchCommandResult;
};

const home = (pool: string): ThreadTurn => ({
  pools: { top: pool, projects: {} },
  instructions: { top: [], projects: {} },
  secrets: { top: [], projects: {} },
});

const makeFixture = (authorize: Authorize = () => Effect.succeed(actor)) => {
  const cloud = makeMemoryCloud();
  let currentHome = home(PERSONAL_POOL_ID);
  const dispatches: Array<ObservedDispatch> = [];
  let authorizationCalls = 0;
  const directory: ThreadDirectory.ThreadDirectory["Service"] = {
    forThread: (id) => {
      const handle = cloud.threadDirectory.forThread(id);
      return {
        ...handle,
        dispatch: (who, command, creation) =>
          Effect.tap(handle.dispatch(who, command, creation), (result) =>
            Effect.sync(() => dispatches.push({ command, creation, result })),
          ),
      };
    },
  };
  const contexts = ThreadContexts.of({
    initialModelSelection: () => Effect.succeed(null),
    placeOfProject: () =>
      Effect.succeed({
        contextId: PERSONAL_CONTEXT_ID,
        driveId: "my/personal/user_1",
        remote: false,
      }),
    turn: () => Effect.sync(() => currentHome),
  });
  const layer = ThreadsLive.layer.pipe(
    Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, directory)),
    Layer.provide(Layer.succeed(ThreadContexts, contexts)),
    Layer.provide(ThreadKindTurns.layerNone),
    Layer.provide(Platform.layerCrypto),
    Layer.provide(layerAttachments(makeMemoryObjects())),
  );
  const services = Effect.gen(function* () {
    const threads = yield* Threads.Threads;
    const publisher = yield* createHarnessContinuationPublisher({
      authorize: (request) =>
        Effect.sync(() => authorizationCalls++).pipe(Effect.andThen(authorize(request))),
    });
    return { threads, publisher };
  }).pipe(Effect.provide(layer));

  return {
    cloud,
    dispatches,
    services,
    setHome: (next: ThreadTurn) => {
      currentHome = next;
    },
    authorizationCalls: () => authorizationCalls,
  };
};

const launchAndSettle = (fixture: ReturnType<typeof makeFixture>) =>
  Effect.gen(function* () {
    const { threads, publisher } = yield* fixture.services;
    yield* threads.launch(actor, {
      commandId: CommandId.make("launch-continuation-test"),
      threadId,
      projectId,
      title: "Background work",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("initial-continuation-test"),
        text: "Start the task",
        attachments: [],
      },
    });
    yield* fixture.cloud.settle;
    const snapshot = yield* threads.snapshot(actor, threadId);
    const sourceRun = snapshot.projection.runs[0]!;
    const providerThread = snapshot.projection.providerThreads.find(
      (candidate) => candidate.id === sourceRun.providerThreadId,
    );
    expect(sourceRun.status).toBe("completed");
    expect(sourceRun.providerThreadId).not.toBeNull();
    expect(providerThread).toBeDefined();
    return { threads, publisher, sourceRun, providerThread: providerThread! };
  });

const continuation = (
  sourceRunId: HarnessContinuation["sourceRunId"],
  providerThreadId: HarnessContinuation["providerThreadId"],
  driver: HarnessContinuation["driver"],
  overrides: Partial<HarnessContinuation> = {},
) =>
  ({
    threadId,
    sourceRunId,
    providerThreadId,
    driver,
    messageId: MessageId.make("provider-continuation-message"),
    detail: null,
    delivery: "adapter_buffered",
    ...overrides,
  }) satisfies HarnessContinuation;

describe("HarnessContinuationPublisher", () => {
  it.effect("dispatches a journaled, replayable queued message on the current home and model", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, publisher, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const notification = {
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Background lookup finished.",
      } as const;
      const completions = [
        {
          sourceCallId: "task-call-1",
          sourceOccurrenceId: "provider-occurrence-1",
          block: { type: "text", text: "First task completed." },
        },
        {
          sourceCallId: "task-call-2",
          sourceOccurrenceId: "provider-occurrence-2",
          block: { type: "text", text: "Second task completed." },
        },
        {
          sourceCallId: "task-call-3",
          sourceOccurrenceId: "provider-occurrence-3",
          block: {
            type: "text",
            text: "Final task completed.",
            cache_control: { type: "ephemeral" },
          },
        },
      ] as const satisfies NonNullable<ProviderContinuation["completions"]>;

      yield* threads.dispatch(actor, {
        type: "message.dispatch",
        commandId: CommandId.make("active-user-message"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        messageId: MessageId.make("active-user-message"),
        text: "Keep working",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const active = (yield* threads.snapshot(actor, threadId)).projection.runs.at(-1)!;
      expect(["starting", "running", "waiting"]).toContain(active.status);

      yield* threads.dispatch(actor, {
        type: "thread.model-selection.set",
        commandId: CommandId.make("current-model"),
        threadId,
        modelSelection: { ...scriptedModelSelection, model: "scripted-current" },
      });
      fixture.setHome(home("home-after-move"));
      const before = yield* threads.snapshot(actor, threadId);
      const request = continuation(sourceRun.id, providerThread.id, providerThread.driver, {
        notification,
        detail: "Three background completions finished.",
        completions,
      });
      const expectedProviderContinuation = {
        sourceRunId: sourceRun.id,
        providerThreadId: providerThread.id,
        driver: providerThread.driver,
        completions,
      };

      yield* publisher.publish(request);
      const afterPublish = yield* threads.snapshot(actor, threadId);
      const message = afterPublish.projection.messages.find(
        (item) => item.id === request.messageId,
      )!;
      const followup = afterPublish.projection.runs.find((run) => run.id === message.runId)!;
      expect(message).toMatchObject({
        createdBy: "agent",
        creationSource: "provider",
        role: "user",
        text: "Three background completions finished.",
        notification,
        providerContinuation: expectedProviderContinuation,
      });
      expect(message.providerContinuation).toEqual(expectedProviderContinuation);
      expect(
        afterPublish.projection.messages.filter((item) => item.id === request.messageId),
      ).toHaveLength(1);
      expect(followup).toMatchObject({
        threadId,
        status: "queued",
        modelSelection: { ...scriptedModelSelection, model: "scripted-current" },
      });
      expect(message.runId).toBe(followup.id);

      const commandId = CommandId.make(`provider-continuation:${request.messageId}`);
      const first = fixture.dispatches.find((call) => call.command.commandId === commandId)!;
      expect(first.command).toMatchObject({
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
      });
      if (first.command.type !== "message.dispatch") throw new Error("Expected message dispatch.");
      expect(first.command.providerContinuation).toEqual(expectedProviderContinuation);
      expect(first.creation.pools).toEqual(home("home-after-move").pools);

      yield* publisher.publish(request);
      const replays = fixture.dispatches.filter((call) => call.command.commandId === commandId);
      expect(replays).toHaveLength(2);
      expect(replays[1]!.result.sequence).toBe(replays[0]!.result.sequence);
      expect(
        (yield* threads.snapshot(actor, threadId)).projection.messages.filter(
          (item) => item.id === request.messageId,
        ),
      ).toHaveLength(1);
      expect(fixture.authorizationCalls()).toBe(2);

      const replay = yield* threads
        .subscribe(actor, {
          threadId,
          afterSequence: before.snapshotSequence,
          requestCompletionMarker: true,
        })
        .pipe(
          Stream.flattenIterable,
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        );
      expect(replay).toContainEqual(
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "message.updated",
            payload: expect.objectContaining({
              id: request.messageId,
              providerContinuation: expectedProviderContinuation,
            }),
          }),
        }),
      );

      yield* fixture.cloud.settle;
      const settled = yield* threads.snapshot(actor, threadId);
      expect(settled.projection.runs.find((run) => run.id === followup.id)?.status).toBe(
        "completed",
      );
      expect(
        settled.projection.runs.filter((run) => run.userMessageId === request.messageId),
      ).toHaveLength(1);
      expect(settled.projection.messages.find((item) => item.id === request.messageId)?.runId).toBe(
        followup.id,
      );
    }),
  );

  it.effect("rejects duplicate source occurrences within a batch", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, publisher, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const completion = {
        sourceCallId: "task-call-duplicate",
        sourceOccurrenceId: "provider-occurrence-duplicate",
        block: { type: "text", text: "Task completed." },
      } as const;
      const request = continuation(sourceRun.id, providerThread.id, providerThread.driver, {
        completions: [completion, completion],
      });

      const rejected = yield* publisher.publish(request).pipe(Effect.flip);
      expect(rejected).toBeInstanceOf(HarnessError);
      expect(rejected.cause).toMatchObject({ _tag: "ThreadCommandRejectedError" });
      const snapshot = yield* threads.snapshot(actor, threadId);
      expect(snapshot.projection.messages.some((message) => message.id === request.messageId)).toBe(
        false,
      );
      expect(snapshot.projection.runs).toHaveLength(1);
    }),
  );

  it.effect("rejects the same source occurrence under a different message id", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, publisher, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const completions = [
        {
          sourceCallId: "task-call-replay",
          sourceOccurrenceId: "provider-occurrence-replay",
          block: { type: "text", text: "Task completed." },
        },
      ] as const satisfies NonNullable<ProviderContinuation["completions"]>;
      const first = continuation(sourceRun.id, providerThread.id, providerThread.driver, {
        messageId: MessageId.make("first-occurrence-message"),
        completions,
      });
      const second = { ...first, messageId: MessageId.make("second-occurrence-message") };

      yield* publisher.publish(first);
      const rejected = yield* publisher.publish(second).pipe(Effect.flip);
      expect(rejected).toBeInstanceOf(HarnessError);
      expect(rejected.cause).toMatchObject({ _tag: "ThreadCommandRejectedError" });
      const snapshot = yield* threads.snapshot(actor, threadId);
      expect(
        snapshot.projection.messages.filter((message) => message.id === first.messageId),
      ).toHaveLength(1);
      expect(snapshot.projection.messages.some((message) => message.id === second.messageId)).toBe(
        false,
      );
      expect(
        snapshot.projection.runs.filter((run) => run.userMessageId === first.messageId),
      ).toHaveLength(1);
    }),
  );

  it.effect("preserves distinct occurrences from the same source call", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, publisher, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const completions = [
        {
          sourceCallId: "task-call-repeated",
          sourceOccurrenceId: "provider-occurrence-first",
          block: { type: "text", text: "First completion." },
        },
        {
          sourceCallId: "task-call-repeated",
          sourceOccurrenceId: "provider-occurrence-second",
          block: { type: "text", text: "Second completion." },
        },
      ] as const satisfies NonNullable<ProviderContinuation["completions"]>;
      const request = continuation(sourceRun.id, providerThread.id, providerThread.driver, {
        completions,
      });

      yield* publisher.publish(request);
      const snapshot = yield* threads.snapshot(actor, threadId);
      const message = snapshot.projection.messages.find((item) => item.id === request.messageId)!;
      expect(message.providerContinuation?.completions).toEqual(completions);
      expect(
        snapshot.projection.messages.filter((item) => item.id === request.messageId),
      ).toHaveLength(1);
      expect(
        snapshot.projection.runs.filter((run) => run.userMessageId === request.messageId),
      ).toHaveLength(1);
    }),
  );

  it.effect("keeps message_text delivery as a server message with its supplied text", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, publisher, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const request = continuation(sourceRun.id, providerThread.id, providerThread.driver, {
        messageId: MessageId.make("server-continuation-message"),
        detail: "The delegated child finished.",
        delivery: "message_text",
      });

      yield* publisher.publish(request);
      const snapshot = yield* threads.snapshot(actor, threadId);
      expect(
        snapshot.projection.messages.find((item) => item.id === request.messageId),
      ).toMatchObject({
        createdBy: "agent",
        creationSource: "server",
        text: "The delegated child finished.",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Background activity updated",
        },
      });
      yield* fixture.cloud.settle;
    }),
  );

  it.effect("maps stale provider and archived-thread rejection without reviving the thread", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, publisher, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const request = continuation(
        sourceRun.id,
        providerThread.id,
        ProviderDriverKind.make("old-driver"),
      );

      const staleProvider = yield* publisher.publish(request).pipe(Effect.flip);
      expect(staleProvider).toBeInstanceOf(HarnessError);
      expect(staleProvider.cause).toMatchObject({ _tag: "ThreadCommandRejectedError" });
      expect((yield* threads.snapshot(actor, threadId)).projection.messages).not.toContainEqual(
        expect.objectContaining({ id: request.messageId }),
      );

      yield* threads.dispatch(actor, {
        type: "thread.archive",
        commandId: CommandId.make("archive-before-continuation"),
        threadId,
      });
      const archivedRequest = { ...request, messageId: MessageId.make("archived-continuation") };
      const archived = yield* publisher.publish(archivedRequest).pipe(Effect.flip);
      expect(archived).toBeInstanceOf(HarnessError);
      expect(archived.cause).toMatchObject({ _tag: "ThreadCommandRejectedError" });
      const after = yield* threads.snapshot(actor, threadId);
      expect(after.projection.thread.archivedAt).not.toBeNull();
      expect(after.projection.messages).not.toContainEqual(
        expect.objectContaining({ id: archivedRequest.messageId }),
      );
    }),
  );

  it.effect("rejects a continuation whose source run is no longer productive", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const { threads, sourceRun, providerThread } = yield* launchAndSettle(fixture);
      const snapshot = yield* threads.snapshot(actor, threadId);
      const staleProjection = {
        ...snapshot.projection,
        runs: snapshot.projection.runs.map((run) =>
          run.id === sourceRun.id ? { ...run, status: "failed" as const } : run,
        ),
      };
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("failed-source-continuation"),
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        threadId,
        messageId: MessageId.make("failed-source-continuation"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" as const },
        providerContinuation: {
          sourceRunId: sourceRun.id,
          providerThreadId: providerThread.id,
          driver: providerThread.driver,
        },
      };

      expect(decide(staleProjection, command, { now: DateTime.makeUnsafe(0) })).toMatchObject({
        _tag: "rejected",
        message: "This provider continuation is no longer current.",
      });

      const changedProviderProjection = {
        ...snapshot.projection,
        thread: {
          ...snapshot.projection.thread,
          providerInstanceId:
            "replacement-provider" as typeof snapshot.projection.thread.providerInstanceId,
          modelSelection: {
            ...snapshot.projection.thread.modelSelection,
            instanceId:
              "replacement-provider" as typeof snapshot.projection.thread.providerInstanceId,
          },
        },
      };
      expect(
        decide(changedProviderProjection, command, { now: DateTime.makeUnsafe(0) }),
      ).toMatchObject({
        _tag: "rejected",
        message: "This provider continuation is no longer current.",
      });
    }),
  );

  it.effect("rechecks publisher authority before dispatching", () =>
    Effect.gen(function* () {
      const denied = new HarnessError({
        operation: "events",
        message: "Publisher is no longer current.",
      });
      const fixture = makeFixture(() => Effect.fail(denied));
      const { publisher } = yield* fixture.services;
      const request = continuation(
        "source-run" as HarnessContinuation["sourceRunId"],
        "provider-thread" as HarnessContinuation["providerThreadId"],
        ProviderDriverKind.make("scripted"),
      );

      expect(yield* publisher.publish(request).pipe(Effect.flip)).toBe(denied);
      expect(fixture.authorizationCalls()).toBe(1);
      expect(fixture.dispatches).toHaveLength(0);
    }),
  );
});
