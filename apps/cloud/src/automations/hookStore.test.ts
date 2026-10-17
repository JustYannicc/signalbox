import { AutomationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Platform from "../platform.ts";
import * as Hooks from "./hookStore.ts";

const layer = Hooks.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
  ),
);
const request = {
  kind: "automation",
  target: "hook-1",
  key: "delivery-1",
  payload: { message: "hello" },
} as const;

describe("durable webhook inbox", () => {
  it.effect(
    "retries a failed delivery with its original id and body, then retains only its receipt",
    () =>
      Effect.gen(function* () {
        const hooks = yield* Hooks.HookStore;
        const accepted = yield* hooks.enqueue(request);
        if (accepted.status !== 202) return yield* Effect.die("Unexpected rejection");
        const now = yield* Clock.currentTimeMillis;
        let attempts = 0;
        yield* hooks.drain((row) => {
          attempts += 1;
          expect([row.id, JSON.parse(row.payload)]).toEqual([accepted.deliveryId, request.payload]);
          return Effect.fail(new AutomationError({ message: "Workflow transport is down" }));
        });
        expect(yield* hooks.nextAt).toBe(now + 10_000);
        yield* hooks.drain(() =>
          Effect.sync(() => {
            attempts += 1;
          }),
        );
        expect(attempts).toBe(1);
        yield* TestClock.adjust("10 seconds");
        yield* hooks.drain((row) =>
          Effect.sync(() => {
            attempts += 1;
            expect([row.id, JSON.parse(row.payload), row.attempts]).toEqual([
              accepted.deliveryId,
              request.payload,
              1,
            ]);
          }),
        );
        expect([attempts, yield* hooks.nextAt]).toEqual([2, null]);
        expect(yield* hooks.enqueue(request)).toEqual({ ...accepted, duplicate: true });
        yield* TestClock.adjust("25 hours");
        expect(yield* hooks.enqueue(request)).toMatchObject({ status: 202, duplicate: false });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("limits new requests and still acknowledges a sender's retries", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.HookStore;
      const first = yield* hooks.enqueue({ ...request, maxPerMinute: 2 });
      yield* hooks.enqueue({ ...request, key: "delivery-2", maxPerMinute: 2 });
      expect(yield* hooks.enqueue({ ...request, key: "delivery-3", maxPerMinute: 2 })).toEqual({
        status: 429,
      });
      expect(yield* hooks.enqueue({ ...request, maxPerMinute: 2 })).toEqual({
        ...first,
        duplicate: true,
      });
      yield* TestClock.adjust("1 minute");
      expect(
        yield* hooks.enqueue({ ...request, key: "delivery-3", maxPerMinute: 2 }),
      ).toMatchObject({ status: 202 });
    }).pipe(Effect.provide(layer)),
  );
});
