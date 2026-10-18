import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  saveSession,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";

describe("fresh-session handoff delivery", () => {
  it.effect.each(["failed", "interrupted"] as const)(
    "retries a handoff whose session loaded but whose prompt was %s before provider acceptance",
    (ending) =>
      withObject(freshDatabase(), (engine, runner, context) =>
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
          yield* send(engine, 2, "Finish the original work.");
          const second = yield* liveTurn(runner);
          const secondReport = turnReport(second.runId, second.runOrdinal, second.providerThread);
          const started = {
            ...secondReport.started,
            providerThread: {
              ...secondReport.started.providerThread,
              nativeThreadRef: {
                ...secondReport.started.providerThread.nativeThreadRef,
                nativeId: "session-with-no-prompt",
              },
            },
          };
          yield* runner.batch({ generation: machine.generation, sequence: 2, items: [started] });
          yield* saveSession(context, "session-with-no-prompt");
          if (ending === "failed") {
            yield* runner.batch({
              generation: machine.generation,
              sequence: 3,
              items: [
                {
                  kind: "turn.failed",
                  runId: second.runId,
                  message: "Provider refused the prompt.",
                },
              ],
            });
          } else {
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("interrupt-before-prompt"),
                threadId,
                runId: second.runId,
                holdQueue: true,
              },
              personal,
            );
          }
          yield* send(engine, 3, "Try again.");
          yield* send(engine, 3, "Try again.");
          const retried = yield* liveTurn(runner);
          expect(retried.providerThread.nativeThreadRef).toBeNull();
          expect(retried.message.text).toContain("Finish the original work.");
          expect(retried.message.text).toContain("Hello!");
          expect(retried.message.text.endsWith("User message:\nTry again.")).toBe(true);
          const after = yield* snapshot(engine);
          expect(after.projection.runs).toHaveLength(3);
          expect(after.projection.contextHandoffs).toHaveLength(2);
          expect((yield* liveTurn(runner)).message.text).toBe(retried.message.text);
          expect((yield* snapshot(engine)).head).toBe(after.head);
        }),
      ),
  );
});
