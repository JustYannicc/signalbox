import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { scriptedModelSelection } from "./scriptedProvider.ts";
import {
  freshDatabase,
  launch,
  owner,
  personal,
  snapshot,
  threadId,
  withObject,
} from "./runner/runnerTestKit.ts";

const question = (id: string, blocking = true): SignalboxAskQuestion => ({
  id,
  question: `Which ${id}?`,
  why: "The requirement needs a choice.",
  unblocks: "Preparing the result.",
  recommendation: "first",
  options: [],
  blocking,
  decisionOwner: "Yannic",
  surface: { kind: "kit", component: "text" },
});
const raise = (id = "ask-1"): OrchestrationV2Command => ({
  type: "thread.ask.raise",
  commandId: CommandId.make(`raise:${id}`),
  threadId,
  askId: id,
  ask: {
    kind: "blocker",
    source: { kind: "agent" },
    questions: [question("one"), question("two", false)],
  },
});
const answer = (round: number, id: string): OrchestrationV2Command => ({
  type: "thread.ask.answer",
  commandId: CommandId.make(`answer:${round}`),
  threadId,
  askId: "ask-1",
  round,
  answers: [{ questionId: id, value: "first", comment: "Go ahead." }],
  deferredQuestionIds: [],
  answeredBy: { kind: "person", personId: owner.userId },
});
const settle = (engine: Parameters<Parameters<typeof withObject>[1]>[0]) =>
  Effect.gen(function* () {
    for (let step = 0; step < 100; step++) if (!(yield* engine.step)) return;
    throw new Error("The scripted turn never settled.");
  });

describe("durable cloud asks", () => {
  it.effect(
    "outlives the turn and object, carries leftovers, and starts work from the answer",
    () =>
      Effect.gen(function* () {
        const database = freshDatabase();
        yield* withObject(database, (engine) =>
          Effect.gen(function* () {
            yield* launch(engine, "launch", personal, undefined, scriptedModelSelection);
            yield* engine.dispatch(owner, raise(), personal);
            // A durable ask does not hold the turn open, including its blocking questions.
            yield* settle(engine);
            expect((yield* snapshot(engine)).projection.runs[0]?.status).toBe("completed");
            expect((yield* engine.summary(owner))?.shell.asks?.[0]?.status).toBe("pending");
          }),
        );
        yield* withObject(database, (engine) =>
          Effect.gen(function* () {
            expect(
              (yield* snapshot(engine)).projection.thread.asks?.[0]?.rounds[0]?.questionIds,
            ).toEqual(["one", "two"]);
            const accepted = yield* engine.dispatch(owner, answer(1, "one"), personal);
            const retried = yield* engine.dispatch(owner, answer(1, "one"), personal);
            expect(retried).toEqual(accepted);
            const { projection } = yield* snapshot(engine);
            const ask = projection.thread.asks?.[0];
            expect(ask?.status).toBe("pending");
            expect(ask?.rounds[1]?.questionIds).toEqual(["two"]);
            expect(ask?.rounds[0]?.answers[0]).toMatchObject({
              answeredBy: { personId: owner.userId },
              recommendationTaken: true,
            });
            expect(
              projection.messages.filter(
                (message) => message.id === MessageId.make("ask-answer:answer:1"),
              ),
            ).toHaveLength(1);
            expect(projection.runs.at(-1)?.status).toBe("starting");
            yield* settle(engine);
          }),
        );
        yield* withObject(database, (engine) =>
          Effect.gen(function* () {
            yield* engine.dispatch(owner, answer(2, "two"), personal);
            expect((yield* snapshot(engine)).projection.thread.asks?.[0]?.status).toBe("answered");
            yield* settle(engine);
            expect((yield* snapshot(engine)).projection.runs.at(-1)?.status).toBe("completed");
          }),
        );
      }),
  );

  it.effect("queues an answer while the agent works and archives the remaining questions", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine, "launch", personal, undefined, scriptedModelSelection);
        yield* engine.dispatch(owner, raise(), personal);
        yield* engine.dispatch(owner, answer(1, "one"), personal);
        expect((yield* snapshot(engine)).projection.runs.map((run) => run.status)).toEqual([
          "starting",
          "queued",
        ]);
        yield* settle(engine);
        yield* engine.dispatch(
          owner,
          { type: "thread.archive", commandId: CommandId.make("archive"), threadId },
          personal,
        );
        expect((yield* snapshot(engine)).projection.thread.asks?.[0]?.status).toBe("archived");
        expect(
          (yield* snapshot(engine)).projection.thread.asks?.[0]?.rounds[0]?.answers,
        ).toHaveLength(1);
        expect((yield* engine.summary(owner))?.shell.asks).toEqual([]);
        yield* engine.dispatch(
          owner,
          { type: "thread.unarchive", commandId: CommandId.make("unarchive"), threadId },
          personal,
        );
        expect((yield* snapshot(engine)).projection.thread.asks?.[0]?.status).toBe("pending");
        yield* engine.dispatch(owner, answer(2, "two"), personal);
        expect((yield* snapshot(engine)).projection.thread.asks?.[0]?.status).toBe("answered");
        expect((yield* engine.summary(owner))?.shell.asks).toEqual([]);
      }),
    ),
  );
});
