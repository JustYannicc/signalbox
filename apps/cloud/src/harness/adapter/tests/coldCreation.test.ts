import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { fixture } from "./fixture.ts";

describe("fresh native thread initialization", () => {
  it.effect("discovers the native thread before any turn and keeps the same runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const existing = { ...f.turn.providerThread, nativeThreadRef: null };
      const supplied = { ...f.input, creation: { providerThread: existing } };
      const { session } = yield* f.open(supplied);
      expect(f.calls).toEqual(["ensure"]);
      expect(f.opened).toHaveLength(1);
      const checkpoint = yield* session.export();
      expect(checkpoint.snapshot.providerThread.nativeThreadRef).toEqual({
        driver: f.turn.providerThread.driver,
        nativeId: "native-thread",
        strength: "strong",
      });
      expect(checkpoint.snapshot.providerTurns).toEqual([]);
      yield* session.turn({ ...f.turn, providerThread: checkpoint.snapshot.providerThread });
      yield* f.nextStart;
      expect(f.calls.filter((call) => call === "ensure")).toHaveLength(1);
      expect(f.opened).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an existing native identity before opening the runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const supplied = {
        ...f.input,
        creation: {
          providerThread: {
            ...f.turn.providerThread,
            nativeThreadRef: {
              driver: f.turn.providerThread.driver,
              nativeId: "existing-native-thread",
              strength: "strong" as const,
            },
          },
        },
      };
      const result = yield* f.service.open(supplied).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(f.opened).toEqual([]);
      expect(f.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
