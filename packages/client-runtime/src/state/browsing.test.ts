import type { BrowsingStreamItem } from "@t3tools/contracts/signalboxBrowsing";
import { SignalboxBrowsingError } from "@t3tools/contracts/signalboxBrowsing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { followBrowsing } from "./browsing.ts";

const snapshot: BrowsingStreamItem = {
  _tag: "Snapshot",
  sequence: 3,
  record: { tabs: [], activeTabId: null, history: [] },
  you: { _tag: "Device", userId: "u1", deviceId: "phone" },
};

describe("followBrowsing", () => {
  it.effect("keeps trying a thread the cloud doesn't know yet, then follows it", () =>
    Effect.gen(function* () {
      let attempts = 0;
      // A brand-new thread: the first subscribe can land before the cloud created it.
      const subscribe = Stream.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Stream.fail(new SignalboxBrowsingError({ message: "Thread not found." }))
          : Stream.make(snapshot);
      });
      const fiber = yield* Effect.forkChild(
        followBrowsing(subscribe).pipe(Stream.take(1), Stream.runCollect),
      );
      yield* TestClock.adjust("2 seconds");
      const [state] = yield* Fiber.join(fiber);
      expect(attempts).toBe(2);
      expect(state?.sequence).toBe(3);
      expect(state?.you).toEqual(snapshot.you);
    }),
  );
});
