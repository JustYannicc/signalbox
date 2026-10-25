import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { ChatArchiveAlarm } from "./chatArchive.ts";
import * as LocalChatArchiveAlarm from "./LocalChatArchiveAlarm.ts";

it.effect(
  "fires once at the earliest archive deadline without letting later arms postpone it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Scope.Scope);
        const fired: number[] = [];
        const context = yield* Layer.build(
          LocalChatArchiveAlarm.layer(
            scope,
            Effect.flatMap(Clock.currentTimeMillis, (at) =>
              Effect.sync(() => {
                fired.push(at);
              }),
            ),
          ),
        );
        const alarm = Context.get(context, ChatArchiveAlarm);
        const now = yield* Clock.currentTimeMillis;
        yield* alarm.armBy(now + 300);
        yield* alarm.armBy(now + 500);
        yield* alarm.armBy(now + 100);
        yield* TestClock.adjust("100 millis");
        expect(fired).toEqual([now + 100]);
        yield* TestClock.adjust("500 millis");
        expect(fired).toEqual([now + 100]);
      }),
    ),
);

it.effect("cancels the pending archive callback when its local domain closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Scope.Scope);
      let fired = false;
      const context = yield* Layer.build(
        LocalChatArchiveAlarm.layer(
          scope,
          Effect.sync(() => {
            fired = true;
          }),
        ),
      );
      const alarm = Context.get(context, ChatArchiveAlarm);
      yield* alarm.armBy((yield* Clock.currentTimeMillis) + 100);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("100 millis");
      expect(fired).toBe(false);
    }),
  ),
);
