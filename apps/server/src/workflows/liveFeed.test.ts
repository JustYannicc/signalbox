import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { COALESCE_WINDOW, makeLiveFeed, runShows, type Change } from "./liveFeed.ts";

const stepMoved = (runId: string): Change => ({
  kind: "runs",
  automationId: "automation-1",
  runId,
  summary: false,
});

it.effect("a view reads once per batch for all its watchers, and sends only what changed", () =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<Change>();
    const feed = yield* makeLiveFeed(changes);
    let value = 1;
    let reads = 0;
    const readsDone = yield* Queue.unbounded<number>();
    const read = Effect.sync(() => ({ value })).pipe(
      Effect.tap(() => Queue.offer(readsDone, ++reads)),
    );
    const first = yield* Queue.unbounded<{ readonly value: number }>();
    const second = yield* Queue.unbounded<{ readonly value: number }>();
    for (const sink of [first, second])
      yield* Stream.runForEach(feed.watch("run:r1", read, runShows("r1")), (seen) =>
        Queue.offer(sink, seen),
      ).pipe(Effect.forkScoped);
    expect(yield* Queue.take(first)).toEqual({ value: 1 });
    expect(yield* Queue.take(second)).toEqual({ value: 1 });

    // Another run's change isn't read; this run's is, but nothing changed, so nothing is sent.
    yield* PubSub.publish(changes, stepMoved("r2"));
    yield* TestClock.adjust(COALESCE_WINDOW);
    yield* PubSub.publish(changes, stepMoved("r1"));
    yield* TestClock.adjust(COALESCE_WINDOW);
    expect(yield* Queue.take(readsDone)).toBe(1);
    expect(yield* Queue.take(readsDone)).toBe(2);

    value = 2;
    yield* PubSub.publish(changes, stepMoved("r1"));
    yield* TestClock.adjust(COALESCE_WINDOW);
    expect(yield* Queue.take(readsDone)).toBe(3);
    const next = yield* Queue.take(first);
    expect(next).toEqual({ value: 2 });
    expect(yield* Queue.take(second)).toBe(next);
    expect(reads).toBe(3);
  }).pipe(Effect.scoped),
);
