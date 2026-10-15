import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import * as UserDirectory from "../user/UserDirectory.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import { wire } from "./threadWire.ts";

/** Events per call to the owner's object. */
export const EVENT_BATCH_SIZE = 200;

const deliveredEvents = Metric.counter("signalbox_cloud_thread_events_delivered_total", {
  description: "Thread events delivered to their owner's automations, by outcome.",
});

/**
 * Delivers the thread's committed events to its owner's automations
 * (`automations/CloudAutomations.ts`), in order and in batches, from where
 * the owner's object last acknowledged. The cursor moves only after a call
 * succeeds, so a failed one is sent again: at least once, ordered. The owner
 * drops events it already took. True when nothing is left to deliver.
 */
export const deliverPendingEvents = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const users = yield* UserDirectory.UserDirectory;
  while (true) {
    const pending = yield* engine.pendingEvents(EVENT_BATCH_SIZE);
    const through = pending?.events.at(-1)?.sequence;
    if (pending === null || through === undefined) return true;
    const count = pending.events.length;
    const delivered = yield* users
      .forUser(pending.ownerUserId)
      .threadEvents({ threadId: pending.threadId, events: wire.events.encode(pending.events) })
      .pipe(
        Effect.andThen(engine.acknowledgeEvents(through)),
        Effect.andThen(
          Metric.update(Metric.withAttributes(deliveredEvents, { outcome: "delivered" }), count),
        ),
        Effect.as(true),
        Effect.catchTags({
          UserObjectError: (error) =>
            Effect.logWarning("thread event delivery failed; will retry", {
              threadId: pending.threadId,
              cause: error,
            }).pipe(
              Effect.andThen(
                Metric.update(Metric.withAttributes(deliveredEvents, { outcome: "failed" }), count),
              ),
              Effect.as(false),
            ),
        }),
        // Who and where, never what (#284): ids only.
        Effect.withSpan("ThreadObject.deliverEvents", {
          attributes: { "thread.id": pending.threadId, "person.id": pending.ownerUserId },
        }),
      );
    if (!delivered) return false;
  }
});
