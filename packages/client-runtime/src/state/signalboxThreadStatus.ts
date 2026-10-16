import { SIGNALBOX_THREAD_STATUS_WS_METHODS } from "@t3tools/contracts/signalboxStatusLine";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import { applyThreadStatusItem, type ThreadStatusNotes } from "./threadStatusLine.ts";

/**
 * Every thread's status note, for one environment, kept current from one
 * snapshot and then one small frame per changed note. Only environments
 * advertising `capabilities.threadStatusNotes` serve them.
 */
export function createSignalboxThreadStatusAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    notes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-thread-status:notes",
      tag: SIGNALBOX_THREAD_STATUS_WS_METHODS.subscribe,
      transform: (stream) =>
        stream.pipe(
          Stream.scan((): ThreadStatusNotes => new Map(), applyThreadStatusItem),
          // The empty seed is not an answer yet; the snapshot is.
          Stream.drop(1),
        ),
    }),
  };
}
