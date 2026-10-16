import {
  type BrowsingStreamItem,
  SIGNALBOX_BROWSING_WS_METHODS,
} from "@t3tools/contracts/signalboxBrowsing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import {
  type BrowsingState,
  foldBrowsingItem,
  INITIAL_BROWSING_STATE,
} from "../browsing/browsingRecord.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Up to 30 s between tries: a thread the cloud is about to create shows up within a second. */
const RETRY_SCHEDULE = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * A thread's record as it changes. A subscription can land before the cloud
 * created a brand-new thread, so a failed one tries again; each try starts
 * from a fresh snapshot, which the fold takes as the whole record.
 */
export const followBrowsing = <E, R>(stream: Stream.Stream<BrowsingStreamItem, E, R>) =>
  stream.pipe(
    Stream.retry(RETRY_SCHEDULE),
    Stream.scan((): BrowsingState => INITIAL_BROWSING_STATE, foldBrowsingItem),
    Stream.drop(1),
  );

/**
 * A thread's synced browser tabs (`signalboxBrowsing.ts`). Only ask
 * environments advertising `capabilities.threadBrowsing`; others fail with
 * `SignalboxBrowsingUnavailableError`.
 */
export function createBrowsingAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const scheduler = createAtomCommandScheduler();
  return {
    /** Input `{ threadId }`. The folded record; a reconnect starts again from a snapshot. */
    thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:browsing:thread",
      tag: SIGNALBOX_BROWSING_WS_METHODS.subscribe,
      // Scrolling only lands while someone reads the thread, so let it go soon after.
      idleTtlMs: 30_000,
      transform: followBrowsing,
    }),
    /** Input `{ threadId, command }`. Commands for one thread apply in order. */
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browsing:dispatch",
      tag: SIGNALBOX_BROWSING_WS_METHODS.dispatch,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
