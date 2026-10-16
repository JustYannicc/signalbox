import { SIGNALBOX_BROWSING_WS_METHODS } from "@t3tools/contracts/signalboxBrowsing";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import { foldBrowsingItem, INITIAL_BROWSING_STATE } from "../browsing/browsingRecord.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
      transform: (stream) =>
        stream.pipe(
          Stream.scan(() => INITIAL_BROWSING_STATE, foldBrowsingItem),
          Stream.drop(1),
        ),
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
