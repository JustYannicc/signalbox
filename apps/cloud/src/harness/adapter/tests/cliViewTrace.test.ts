import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { fixture } from "./fixture.ts";

describe("Harness CLI view traces", () => {
  it.effect("tags early traces with the next turn and counts the ones it could not keep", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const opened = yield* f.open();
      for (let index = 0; index < 40; index++)
        f.reportCliViewTrace({ kind: "loop-lag", lagMs: 300 + index, activity: "no round, open" });
      yield* opened.session.turn(f.turn);
      expect((yield* opened.next).kind).toBe("turn.started");
      f.reportCliViewTrace({ kind: "round", phase: "start", mode: "index", entries: 5 });
      const logs: unknown[] = [];
      while (logs.length < 34) {
        const item = yield* opened.next;
        if (item.kind !== "log") continue;
        expect(item.runId).toBe(f.turn.runId);
        logs.push(JSON.parse(item.message));
      }
      expect(logs).toHaveLength(34);
      expect(logs[31]).toMatchObject({ kind: "loop-lag", lagMs: 331 });
      expect(logs[32]).toEqual({ type: "harness.cli-view-trace", kind: "dropped", count: 8 });
      expect(logs[33]).toMatchObject({ kind: "round", mode: "index" });
    }).pipe(Effect.scoped),
  );
});
