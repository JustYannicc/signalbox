import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { SCRATCH_PROJECT_ID } from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { CloudThreadService } from "./CloudThreadService.ts";
import { ThreadCommandRejectedError } from "./ThreadEngine.ts";
import * as ThreadInbox from "./ThreadInbox.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { scriptedStep } from "./scriptedTurn.ts";
import { recoverRunEvents } from "./ThreadRecovery.ts";
import { applyEvents } from "./threadProjection.ts";

const actor = { userId: "inbox-user", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("inbox-thread");
const input = {
  commandId: CommandId.make("inbox-launch"),
  threadId,
  projectId: SCRATCH_PROJECT_ID,
  title: "Inbox",
  modelSelection: scriptedModelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspaceStrategy: { type: "root" as const },
};
const message = {
  type: "message.dispatch" as const,
  commandId: CommandId.make("inbox-post"),
  threadId,
  messageId: MessageId.make("inbox-message"),
  text: "INBOX_RESULT",
  attachments: [],
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
  dispatchMode: { type: "queue_after_active" as const },
};
const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory
    .forUser(actor.userId)
    .recordSignIn({ id: actor.userId, email: "inbox@b.c" });
  const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(actor.userId)));
  const inbox = yield* ThreadInbox.make.pipe(Effect.provide(cloud.layerFor(actor.userId)));
  yield* inbox.start(actor, input);
  return { cloud, threads, inbox };
});

describe("thread inbox", () => {
  it.effect("waits through recovery and returns the continuation's committed result", () =>
    Effect.gen(function* () {
      const { cloud, threads, inbox } = yield* setup;
      const receipt = yield* inbox.post(actor, message);
      const before = yield* threads.threadSnapshot(actor, threadId);
      const context = { now: DateTime.makeUnsafe(yield* Clock.currentTimeMillis) };
      const started = applyEvents(before.projection, scriptedStep(before.projection, context))!;
      const original = started.runs.find((run) => run.id === receipt.runId)!;
      const recovered = applyEvents(started, recoverRunEvents(started, original, context))!;
      let finished = recovered;
      for (let step = 0; step < 20 && finished.runs.at(-1)?.status !== "completed"; step++)
        finished = applyEvents(finished, scriptedStep(finished, context))!;
      expect(finished.runs.at(-1)?.status).toBe("completed");
      const controlled = yield* ThreadInbox.make.pipe(
        Effect.provideService(CloudThreadService, {
          ...threads,
          threadSnapshot: () => Effect.succeed({ ...before, projection: started }),
          subscribeThread: () =>
            Stream.make(
              [{ kind: "snapshot" as const, snapshotSequence: 100, projection: recovered }],
              [{ kind: "snapshot" as const, snapshotSequence: 200, projection: finished }],
            ),
        }),
        Effect.provide(cloud.layerFor(actor.userId)),
      );
      const answer = yield* controlled.wait(actor, {
        threadId,
        runId: original.id,
        followRecovery: true,
      });
      expect(answer).toMatchObject({
        runId: finished.runs.at(-1)?.id,
        status: "completed",
        timedOut: false,
        sequence: 200,
        result: { text: expect.stringContaining("Continue where you left off.") },
      });
    }),
  );

  it.effect("distinguishes a run race from a saved refusal and retries the same message", () =>
    Effect.gen(function* () {
      const { inbox } = yield* setup;
      yield* inbox.post(actor, message);
      const next = { ...message, messageId: MessageId.make("next-message"), text: "NEXT_RESULT" };
      const failure = yield* Effect.flip(inbox.post(actor, next, null));
      expect(failure.code).toBe("run_changed");
      const current = (yield* inbox.read(actor, threadId)).runs[0]!;
      const accepted = yield* inbox.post(actor, next, { id: current.id, status: current.status });
      expect(accepted.delivery).toBe("queued");
      expect((yield* inbox.read(actor, threadId)).runs).toHaveLength(2);
    }),
  );

  it.effect("deduplicates delivery by message id across command ids and service recreation", () =>
    Effect.gen(function* () {
      const { cloud, threads, inbox } = yield* setup;
      const first = yield* inbox.post(actor, message);
      const queued = {
        ...message,
        commandId: CommandId.make("queued"),
        messageId: MessageId.make("queued-message"),
        text: "QUEUED_RESULT",
      };
      yield* inbox.post(actor, queued);
      yield* cloud.settle;
      const restarted = yield* ThreadInbox.make.pipe(Effect.provide(cloud.layerFor(actor.userId)));
      const retry = yield* restarted.post(actor, {
        ...message,
        commandId: CommandId.make("retry"),
      });
      expect(retry.runId).toBe(first.runId);
      expect(retry.sequence).toBe(first.sequence);
      // A caller bypassing the adapter still cannot redeliver an existing message id.
      yield* threads.dispatchCommand(actor, { ...message, commandId: CommandId.make("raw-retry") });
      const state = yield* restarted.read(actor, threadId);
      expect(state.runs).toHaveLength(2);
      expect(state.messages.filter((item) => item.id === message.messageId)).toHaveLength(1);
      const events = yield* cloud.threadEvents(threadId);
      const messagePosition = events.findIndex(
        (event) => event.type === "message.updated" && event.payload.id === queued.messageId,
      );
      const runPosition = events.findIndex(
        (event) => event.type === "run.created" && event.payload.userMessageId === queued.messageId,
      );
      expect(messagePosition).toBeGreaterThanOrEqual(0);
      expect(runPosition).toBeGreaterThan(messagePosition);
    }),
  );

  it.effect("recovers initial delivery after creation committed and delivery failed", () =>
    Effect.gen(function* () {
      const { cloud, threads, inbox } = yield* setup;
      const child = {
        ...input,
        threadId: ThreadId.make("inbox-child"),
        commandId: CommandId.make("child-launch"),
        initialMessage: { text: "CHILD_RESULT", attachments: [] },
      };
      const deliveryError = new ThreadCommandRejectedError({
        commandId: "delivery",
        commandType: "message.dispatch",
        reason: "private upstream failure detail",
      });
      const failed = yield* ThreadInbox.make.pipe(
        Effect.provideService(CloudThreadService, {
          ...threads,
          dispatchCommand: () => Effect.fail(deliveryError),
        }),
        Effect.provide(cloud.layerFor(actor.userId)),
      );
      const failure = yield* Effect.flip(failed.start(actor, child));
      expect(failure.code).toBe("rejected");
      expect(failure.message).toBe("The thread inbox rejected the request.");
      expect(failure.cause).toBe(deliveryError);
      expect((yield* inbox.read(actor, child.threadId)).runs).toHaveLength(0);
      yield* inbox.start(actor, child);
      yield* inbox.start(actor, child);
      yield* cloud.settle;
      const state = yield* inbox.read(actor, child.threadId);
      expect(state.runs).toHaveLength(1);
      expect(
        state.messages.filter((item) => item.role === "user").map((item) => item.text),
      ).toEqual(["CHILD_RESULT"]);
    }),
  );

  it.effect(
    "returns the result and terminal state from one committed sequence, live or resumed",
    () =>
      Effect.gen(function* () {
        const { cloud, threads, inbox } = yield* setup;
        const posted = yield* inbox.post(actor, message);
        const subscribed = yield* Deferred.make<void>();
        const live = yield* ThreadInbox.make.pipe(
          Effect.provideService(CloudThreadService, {
            ...threads,
            subscribeThread: (who, query) =>
              threads
                .subscribeThread(who, query)
                .pipe(Stream.tap(() => Deferred.succeed(subscribed, undefined))),
          }),
          Effect.provide(cloud.layerFor(actor.userId)),
        );
        const waiting = yield* live
          .wait(actor, { threadId, runId: posted.runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        yield* cloud.settle;
        const answer = yield* Fiber.join(waiting);
        expect(answer).toMatchObject({
          status: "completed",
          timedOut: false,
          result: { text: expect.stringContaining("INBOX_RESULT") },
        });
        const state = yield* inbox.read(actor, threadId);
        expect(answer.sequence).toBeLessThanOrEqual(state.sequence);
        expect(state.messages.find((item) => item.id === answer.result?.messageId)?.text).toBe(
          answer.result?.text,
        );
        const resumed = yield* inbox.wait(actor, { threadId, runId: posted.runId });
        expect(resumed).toMatchObject({
          status: "completed",
          result: answer.result,
          sequence: state.sequence,
        });
      }),
  );
});
