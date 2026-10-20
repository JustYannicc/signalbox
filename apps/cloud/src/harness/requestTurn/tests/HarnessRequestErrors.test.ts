import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HarnessError } from "../../Harness.ts";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { createHarnessRequestTurn } from "../../HarnessRequestTurn.ts";
import { requestFixture } from "./fixture.ts";

describe("Harness request error translation", () => {
  it.effect.each(["verify", "restore"] as const)("preserves an existing %s domain error", (stage) =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const error = new HarnessRequestFacetError(`Precise ${stage} failure`);
      const open = createHarnessRequestTurn({ ...f.options, [stage]: () => Effect.fail(error) });
      const result = yield* open(f.initial, f.context("request-1")).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBe(error);
    }).pipe(Effect.scoped),
  );

  it.effect("identifies a program seed failure without wrapping restoration again", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      f.setHost({
        programs: {
          ...f.instance.options.programs,
          read: async () => {
            throw new Error("Missing committed program bytes");
          },
        },
      });
      const result = yield* f.open(f.context("request-1")).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).toBe("Canonical Harness program seed verification failed.");
        expect(result.failure.cause).toBeInstanceOf(HarnessError);
      }
    }).pipe(Effect.scoped),
  );
});
