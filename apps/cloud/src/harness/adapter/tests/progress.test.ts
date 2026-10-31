import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { fixture } from "./fixture.ts";

describe("Harness turn milestones", () => {
  it.effect("bounds repeated reports, ignores idle reports and correlates each new turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const opened = yield* f.open();
      f.reportTurnMilestone("model-request-sent");
      for (const ordinal of [1, 2]) {
        const turn = {
          ...f.turn,
          runId: RunId.make(`milestone-turn-${ordinal}`),
          attemptId: RunAttemptId.make(`milestone-attempt-${ordinal}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
        };
        yield* opened.session.turn(turn);
        expect((yield* opened.next).kind).toBe("turn.started");
        if (ordinal === 1) expect((yield* opened.next).kind).toBe("provider");
        for (let count = 0; count < 1_000; count++) f.reportTurnMilestone("model-request-sent");
        expect(yield* opened.next).toEqual({
          kind: "log",
          runId: turn.runId,
          level: "info",
          message: JSON.stringify({ type: "harness.turn-milestone", stage: "model-request-sent" }),
        });
        yield* f.terminal(turn);
        expect((yield* opened.next).kind).toBe("provider");
        const terminal = yield* opened.next;
        expect(terminal.kind === "provider" && terminal.event.type).toBe("turn.terminal");
        f.reportTurnMilestone("first-model-byte");
      }
      expect(opened.events.filter((item) => item.kind === "log")).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});
