import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import { ChatArchiveAlarm } from "./chatArchive.ts";

interface Scheduled<E> {
  readonly at: number;
  readonly token: object;
  readonly fiber: Fiber.Fiber<void, E> | null;
}

/** Keeps the earliest persisted archive deadline and runs the production alarm when it arrives. */
export const layer = <E>(scope: Scope.Closeable, run: Effect.Effect<void, E>) =>
  Layer.effect(
    ChatArchiveAlarm,
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const scheduled = yield* Ref.make<Scheduled<E> | null>(null);
      const armBy: ChatArchiveAlarm["Service"]["armBy"] = (at) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* Ref.get(scheduled);
            if (previous !== null && previous.at <= at) return;
            if (previous !== null && previous.fiber !== null) {
              yield* Fiber.interrupt(previous.fiber);
            }

            const token = {};
            yield* Ref.set(scheduled, { at, token, fiber: null });
            const now = yield* Clock.currentTimeMillis;
            const fiber = yield* Effect.sleep(Math.max(0, at - now)).pipe(
              Effect.andThen(
                lock.withPermits(1)(
                  Effect.gen(function* () {
                    const current = yield* Ref.get(scheduled);
                    if (current?.token !== token) return false;
                    yield* Ref.set(scheduled, null);
                    return true;
                  }),
                ),
              ),
              Effect.flatMap((fire) => (fire ? run : Effect.void)),
              Effect.forkIn(scope),
            );
            yield* Ref.update(scheduled, (current) =>
              current?.token === token ? { ...current, fiber } : current,
            );
          }),
        );
      return ChatArchiveAlarm.of({ armBy });
    }),
  );
