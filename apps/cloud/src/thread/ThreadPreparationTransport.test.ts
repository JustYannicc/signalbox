import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { loadingPreparation, preparationApi } from "./preparationTesting.ts";
import { freshDatabase, owner, withObject } from "./runnerTesting.ts";

describe("preparation stop transport", () => {
  it.effect(
    "sends the stop before awaiting it and leaves the engine free to commit the acknowledgement",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          const { target, pushWork, socket, say } = yield* loadingPreparation(engine, runner);
          const outer = yield* Effect.context<never>();
          const sent = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const api = preparationApi(Context.merge(outer, context), async () => {
            await pushWork();
            Deferred.doneUnsafe(sent, Effect.void);
          });
          const response = yield* Effect.promise(() => api.cancelPreparation(owner, target)).pipe(
            Effect.tap(() => Deferred.succeed(completed, undefined)),
            Effect.forkChild,
          );
          yield* Deferred.await(sent);
          expect(socket.sent).toContainEqual({
            type: "preparation.cancel",
            runId: target.runId,
            preparationGeneration: target.preparationGeneration,
          });
          expect(yield* Deferred.isDone(completed)).toBe(false);
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.cancelled", ...target }],
          });
          expect(yield* Fiber.join(response)).toEqual({ _tag: "ok", value: { cancelled: true } });
        }),
      ),
  );
});
