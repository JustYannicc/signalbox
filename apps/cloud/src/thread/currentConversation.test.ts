import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { matchThread, threadTurns } from "../context/threadContext.ts";
import { runEvent } from "./threadEvents.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  send,
  snapshot,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

describe("current conversation after rollback", () => {
  it.effect(
    "keeps removed messages in audit history but excludes them from continuation and search",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const first = yield* liveTurn(runner);
          const firstReport = turnReport(first.runId, first.runOrdinal, first.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [firstReport.started, firstReport.full, firstReport.terminal],
          });
          yield* send(engine, 2, "Discarded zebra request");
          const second = yield* liveTurn(runner);
          const secondReport = turnReport(second.runId, second.runOrdinal, second.providerThread, {
            replyText: "Discarded zebra answer",
          });
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [secondReport.started, secondReport.full, secondReport.terminal],
          });
          yield* engine.apply((projection, ctx) => {
            const run = projection?.runs.find((run) => run.id === second.runId);
            if (run === undefined) throw new Error("Missing second run");
            return Effect.succeed({
              events: [runEvent(ctx, "run.updated", { ...run, status: "rolled_back" })],
              result: undefined,
            });
          });
          const { projection } = yield* snapshot(engine);
          expect(projection.messages.some((message) => message.text.includes("zebra"))).toBe(true);
          expect(matchThread(projection, ["zebra"])).toBeNull();
          expect(threadTurns(projection, null).map((turn) => turn.turn)).toEqual([1]);
          yield* send(engine, 3, "Continue after undo");
          const next = yield* liveTurn(runner);
          expect(next.message.text).toContain("Hello!");
          expect(next.message.text).toContain("Continue after undo");
          expect(next.message.text).not.toContain("zebra");
        }),
      ),
  );
});
