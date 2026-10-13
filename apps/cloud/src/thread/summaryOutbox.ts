import * as Effect from "effect/Effect";

import * as UserDirectory from "../user/UserDirectory.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import { wire } from "./threadWire.ts";

/**
 * Delivers the thread's latest sidebar row to its owner's index, if the index
 * has not acknowledged it yet. The revision is recorded with the events that
 * changed the row, so it survives a crash before delivery; the owner ignores a
 * revision it already has, so delivering twice is harmless. True when nothing
 * is left to deliver.
 */
export const deliverPendingSummary = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const pending = yield* engine.pendingSummary;
  if (pending === null) return true;
  const users = yield* UserDirectory.UserDirectory;
  return yield* users
    .forUser(pending.ownerUserId)
    .recordThreadSummary(wire.summary.encode(pending.summary))
    .pipe(
      Effect.andThen(engine.acknowledgeSummary(pending.summary.revision)),
      Effect.as(true),
      Effect.catchTags({
        UserObjectError: (error) =>
          Effect.logWarning("thread summary delivery failed; will retry", {
            threadId: pending.summary.threadId,
            cause: error,
          }).pipe(Effect.as(false)),
      }),
    );
});
