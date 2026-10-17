import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeMemoryCloud } from "../testing.ts";
import { SCRATCH_PROJECT_ID } from "../environment.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { ThreadCommandRejectedError } from "../thread/ThreadEngine.ts";
import * as ThreadInbox from "../thread/ThreadInbox.ts";
import { applyEvents } from "../thread/threadProjection.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { scriptedStep } from "../thread/scriptedTurn.ts";
import { recoverRunEvents } from "../thread/ThreadRecovery.ts";
import { decide } from "../thread/threadDecider.ts";
import { CloudCollaboration, make } from "./CloudCollaboration.ts";
import { deliverCompletion } from "./completion.ts";
import { CollaborationError } from "./errors.ts";
import {
  completeRun,
  controlledParentThreads,
  queuedParent,
  stopRecovery,
} from "./tests/completionHarness.ts";

const actor = { userId: "completion-user", contextIds: [PERSONAL_CONTEXT_ID] };
const source = ThreadId.make("completion-source");

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory
    .forUser(actor.userId)
    .recordSignIn({ id: actor.userId, email: "a@b.c" });
  const layer = cloud.layerFor(actor.userId);
  const threads = yield* CloudThreadService.pipe(Effect.provide(layer));
  yield* threads.launchThread(actor, {
    commandId: CommandId.make("completion-launch"),
    threadId: source,
    projectId: SCRATCH_PROJECT_ID,
    title: "Completion parent",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  const service = yield* make.pipe(
    Effect.provide(ThreadInbox.layer.pipe(Layer.provideMerge(layer))),
  );
  const child = yield* service.delegate(source, { task: "RECOVERED_CHILD_RESULT" });
  const snapshot = yield* threads.threadSnapshot(actor, child.childThreadId);
  let projection = snapshot.projection;
  const context = { now: DateTime.makeUnsafe(yield* Clock.currentTimeMillis) };
  const advance = () => {
    const events = scriptedStep(projection, context);
    if (events.length === 0) throw new Error("Expected the child to advance.");
    projection = applyEvents(projection, events)!;
    return events;
  };
  const projectedThreads = {
    ...threads,
    threadSnapshot: (who: Parameters<typeof threads.threadSnapshot>[0], threadId: ThreadId) =>
      threads.threadSnapshot(who, threadId).pipe(
        Effect.map((state) => ({
          ...state,
          projection: threadId === child.childThreadId ? projection : state.projection,
        })),
      ),
  };
  const deliver = (events: ReturnType<typeof scriptedStep>, dispatch = threads.dispatchCommand) =>
    deliverCompletion(
      child.childThreadId,
      events.map((event) => ({ event })),
    ).pipe(
      Effect.provide(ThreadInbox.layer),
      Effect.provideService(CloudThreadService, { ...projectedThreads, dispatchCommand: dispatch }),
      Effect.provideService(CloudCollaboration, service),
      Effect.provide(layer),
    );
  const finish = () => {
    const events: ReturnType<typeof scriptedStep>[number][] = [];
    for (let step = 0; step < 20; step++) {
      const latest = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (latest?.status === "completed") return events;
      events.push(...advance());
    }
    throw new Error("The child did not finish.");
  };
  return {
    cloud,
    threads,
    child,
    service,
    context,
    advance,
    finish,
    deliver,
    projection: () => projection,
    replace: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
  };
});

describe("child completion delivery", () => {
  it.effect("stops recovered work while preserving an unrelated later queued turn", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      env.advance();
      const original = env.projection().runs[0]!;
      const queued = decide(
        env.projection(),
        {
          type: "message.dispatch",
          commandId: CommandId.make("later-child-turn"),
          threadId: env.child.childThreadId,
          messageId: MessageId.make("later-child-message"),
          text: "Keep this later work",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        },
        env.context,
      );
      if (queued._tag !== "accepted") throw new Error(queued.message);
      env.replace(applyEvents(env.projection(), queued.events)!);
      const recovery = recoverRunEvents(env.projection(), original, env.context);
      env.replace(applyEvents(env.projection(), recovery)!);
      const continuation = env
        .projection()
        .runs.find((run) => run.restartContinuationOfRunId === original.id)!;
      expect(continuation.ordinal).toBe(3);
      const controlled = {
        ...env.threads,
        threadSnapshot: (who: Parameters<typeof env.threads.threadSnapshot>[0], id: ThreadId) =>
          env.threads.threadSnapshot(who, id).pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: id === env.child.childThreadId ? env.projection() : snapshot.projection,
            })),
          ),
        dispatchCommand: (
          who: Parameters<typeof env.threads.dispatchCommand>[0],
          command: Parameters<typeof env.threads.dispatchCommand>[1],
        ) =>
          !("threadId" in command) || command.threadId !== env.child.childThreadId
            ? env.threads.dispatchCommand(who, command)
            : Effect.gen(function* () {
                const decision = decide(env.projection(), command, env.context);
                if (decision._tag === "rejected")
                  return yield* ThreadCommandRejectedError.forCommand(
                    { id: command.commandId, type: command.type },
                    decision.message,
                  );
                env.replace(applyEvents(env.projection(), decision.events)!);
                return { sequence: 100 };
              }),
      };
      const service = yield* make.pipe(
        Effect.provide(ThreadInbox.layer),
        Effect.provideService(CloudThreadService, controlled),
        Effect.provide(env.cloud.layerFor(actor.userId)),
      );
      expect(
        yield* Effect.result(
          service.wait(env.child.childThreadId, {
            threadId: env.child.childThreadId,
            runId: original.id,
            timeoutMs: 1,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
      yield* service.stopDescendants(source, 0);
      expect(env.projection().runs.find((run) => run.id === continuation.id)?.status).toBe(
        "interrupted",
      );
      expect(env.projection().runs.find((run) => run.ordinal === 2)?.status).toBe("starting");
      yield* service.stopDescendants(source, 0);
      expect(env.projection().runs.find((run) => run.ordinal === 2)?.status).toBe("starting");
    }),
  );

  it.effect("delivers one final result after recovery, under the original task receipt", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      env.advance();
      const started = env.projection();
      const original = started.runs[0]!;
      const recovered = recoverRunEvents(started, original, env.context);
      env.replace(applyEvents(started, recovered)!);
      yield* env.deliver(recovered);
      expect((yield* env.threads.threadSnapshot(actor, source)).projection.runs).toHaveLength(0);
      const finalEvents = env.finish();
      yield* env.deliver(finalEvents);
      yield* env.deliver(finalEvents);
      const parent = (yield* env.threads.threadSnapshot(actor, source)).projection;
      expect(parent.runs).toHaveLength(1);
      expect(parent.messages.filter((message) => message.role === "user")).toMatchObject([
        {
          id: MessageId.make(`cloud-task-result:${env.child.childThreadId}:${original.id}`),
          text: expect.stringContaining("Continue where you left off."),
        },
      ]);
      expect(parent.messages[0]?.text).toContain(" completed.");
    }),
  );

  it.effect("drops permanent delivery refusals but preserves transient failures for retry", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const events = env.finish();
      const rejection = new ThreadCommandRejectedError({
        commandId: "permanent-result",
        commandType: "message.dispatch",
        reason: "Model unavailable",
      });
      yield* env.deliver(events, () => Effect.fail(rejection));
      for (const code of ["run_changed", "unavailable"] as const) {
        const transient = new ThreadCommandRejectedError({
          commandId: "retry-result",
          commandType: "message.dispatch",
          reason: "Retry required",
          code,
        });
        const failure = yield* Effect.flip(env.deliver(events, () => Effect.fail(transient)));
        expect(failure).toMatchObject({ _tag: "ThreadInboxError", code });
        expect("cause" in failure && failure.cause).toBe(transient);
      }
      expect((yield* env.threads.threadSnapshot(actor, source)).projection.runs).toHaveLength(0);
      yield* env.deliver(events);
      expect((yield* env.threads.threadSnapshot(actor, source)).projection.runs).toHaveLength(1);
    }),
  );

  it.effect("delivers a root's child result when a higher recovery continuation was stopped", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const actor = { userId: "completion-user", contextIds: [PERSONAL_CONTEXT_ID] };
      const context = { now: DateTime.makeUnsafe(yield* Clock.currentTimeMillis) };
      const initial = (yield* env.threads.threadSnapshot(actor, source)).projection;
      const started = queuedParent(initial, context);
      const stopped = stopRecovery(started.projection, started.original, context, false);
      const parentProjection = stopped.projection;
      expect(parentProjection.runs.find((run) => run.ordinal === 2)?.status).toBe("starting");
      expect(parentProjection.runs.find((run) => run.ordinal === 3)?.status).toBe("interrupted");

      const controlled = controlledParentThreads(env.threads, source, parentProjection, context);
      const collaboration = yield* make.pipe(
        Effect.provide(ThreadInbox.layer),
        Effect.provideService(CloudThreadService, controlled.service),
        Effect.provide(env.cloud.layerFor(actor.userId)),
      );
      const task = yield* collaboration.delegate(source, {
        task: "Return a result for parent root two",
        clientRequestId: "parent-root-two-child",
      });
      const retry = yield* collaboration.delegate(source, {
        task: "Return a result for parent root two",
        clientRequestId: "parent-root-two-child",
      });
      expect(task.childThreadId).toBe(retry.childThreadId);
      expect(task.childRunId).toBe(retry.childRunId);
      const originalChildRunId = task.childRunId;
      if (originalChildRunId === null) throw new Error("Expected the original child receipt.");

      const completed = yield* completeRun(
        env.threads,
        actor,
        task.childThreadId,
        originalChildRunId,
        context,
      );
      controlled.child(task.childThreadId, completed.projection);
      const deliver = (events: ReadonlyArray<ReturnType<typeof scriptedStep>[number]>) =>
        deliverCompletion(
          task.childThreadId,
          events.map((event) => ({ event })),
        ).pipe(
          Effect.provide(ThreadInbox.layer),
          Effect.provideService(CloudThreadService, controlled.service),
          Effect.provideService(CloudCollaboration, collaboration),
          Effect.provide(env.cloud.layerFor(actor.userId)),
        );
      yield* deliver(completed.events);
      yield* deliver(completed.events);

      const resultMessageId = MessageId.make(
        `cloud-task-result:${task.childThreadId}:${originalChildRunId}`,
      );
      expect(
        controlled.parent().messages.filter((message) => message.id === resultMessageId),
      ).toHaveLength(1);
      expect(controlled.parentDispatchSequences).toHaveLength(2);
      expect(controlled.parentDispatchSequences[1]).toBe(controlled.parentDispatchSequences[0]);
      expect(controlled.parent().runs.find((run) => run.ordinal === 2)?.status).toBe("starting");
    }),
  );

  it.effect("suppresses a child result during a transient stop-cascade retry window", () =>
    Effect.gen(function* () {
      const env = yield* setup;
      const actor = { userId: "completion-user", contextIds: [PERSONAL_CONTEXT_ID] };
      const context = { now: DateTime.makeUnsafe(yield* Clock.currentTimeMillis) };
      const initial = (yield* env.threads.threadSnapshot(actor, source)).projection;
      const started = queuedParent(initial, context);
      const controlled = controlledParentThreads(env.threads, source, started.projection, context);
      const collaboration = yield* make.pipe(
        Effect.provide(ThreadInbox.layer),
        Effect.provideService(CloudThreadService, controlled.service),
        Effect.provide(env.cloud.layerFor(actor.userId)),
      );
      const task = yield* collaboration.delegate(source, {
        task: "Do not deliver after the parent root was stopped",
        clientRequestId: "stopped-root-child",
      });
      const originalChildRunId = task.childRunId;
      if (originalChildRunId === null) throw new Error("Expected the original child receipt.");

      const stopped = stopRecovery(controlled.parent(), started.original, context, true);
      const parentProjection = stopped.projection;
      const { continuation } = stopped;
      controlled.setParent(parentProjection);
      const stopEvent = stopped.events.find(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === continuation.id &&
          event.payload.status === "interrupted",
      );
      if (stopEvent === undefined) throw new Error("Expected the recovery stop event.");

      const retryingCascade = CloudCollaboration.of({
        ...collaboration,
        stopDescendants: () =>
          Effect.fail(CollaborationError.unavailable("stop_descendants", new Error("retry"))),
      });
      expect(
        yield* Effect.result(
          deliverCompletion(source, [{ event: stopEvent }]).pipe(
            Effect.provide(ThreadInbox.layer),
            Effect.provideService(CloudThreadService, controlled.service),
            Effect.provideService(CloudCollaboration, retryingCascade),
            Effect.provide(env.cloud.layerFor(actor.userId)),
          ),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CollaborationError", operation: "stop_descendants" },
      });
      expect(
        yield* collaboration.completion(task.childThreadId, 1, (disposition) =>
          Effect.succeed(disposition),
        ),
      ).toEqual({ allowed: true, parentOrdinal: 1 });

      const completed = yield* completeRun(
        env.threads,
        actor,
        task.childThreadId,
        originalChildRunId,
        context,
      );
      controlled.child(task.childThreadId, completed.projection);
      yield* deliverCompletion(
        task.childThreadId,
        completed.events.map((event) => ({ event })),
      ).pipe(
        Effect.provide(ThreadInbox.layer),
        Effect.provideService(CloudThreadService, controlled.service),
        Effect.provideService(CloudCollaboration, collaboration),
        Effect.provide(env.cloud.layerFor(actor.userId)),
      );

      expect(controlled.parentDispatchSequences).toEqual([]);
      expect(controlled.parent().runs.find((run) => run.ordinal === 2)?.status).toBe("queued");
      expect(
        controlled
          .parent()
          .messages.some((message) =>
            message.id.startsWith(`cloud-task-result:${task.childThreadId}:`),
          ),
      ).toBe(false);
    }),
  );
});
