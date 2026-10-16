import { ellipsize } from "@t3tools/shared/String";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import * as UserDirectory from "../user/UserDirectory.ts";
import * as DriveEvents from "./DriveEvents.ts";
import * as DriveMembers from "./DriveMembers.ts";
import * as DriveStore from "./DriveStore.ts";

/** Moves per call to a person's object. */
export const DRIVE_EVENT_BATCH_SIZE = 50;
/** Commits an event lists; more sets `commitsTruncated`. */
export const EVENT_COMMITS = 20;
const MESSAGE_CHARS = 4_000;

const deliveredEvents = Metric.counter("signalbox_cloud_drive_events_delivered_total", {
  description: "Drive ref moves delivered to people's automations, by outcome.",
});

/**
 * Delivers a drive's ref moves (`DriveEvents`) to each person's own object,
 * in order and in batches, with the commits each brought. An entry goes only
 * once that person's object took it, so a failed call is sent again; their
 * object drops what it already took. Someone who lost access since gets
 * nothing more. True when nothing is left to deliver.
 */
export const deliverDriveEvents = (driveId: string) =>
  Effect.gen(function* () {
    const events = yield* DriveEvents.DriveEvents;
    const members = yield* DriveMembers.DriveMembers;
    const store = yield* DriveStore.DriveStore;
    const users = yield* UserDirectory.UserDirectory;

    // Built once per move, however many people get it.
    const built = new Map<number, DriveEvents.DriveRefEvent>();
    const withCommits = (move: DriveEvents.RefMove) => {
      const known = built.get(move.sequence);
      if (known !== undefined) return Effect.succeed(known);
      return Effect.map(
        store.commitsBetween(move.before, move.after, EVENT_COMMITS + 1),
        (commits): DriveEvents.DriveRefEvent => ({
          ...move,
          commits: commits.slice(0, EVENT_COMMITS).map((commit) => ({
            oid: commit.oid,
            author: commit.authorName,
            message: ellipsize(commit.message, MESSAGE_CHARS),
            parents: commit.parents,
          })),
          commitsTruncated: commits.length > EVENT_COMMITS,
        }),
      ).pipe(Effect.tap((event) => Effect.sync(() => built.set(move.sequence, event))));
    };

    const deliverTo = (userId: string) =>
      Effect.gen(function* () {
        if ((yield* Effect.orDie(members.role(userId))) === null) {
          yield* Effect.orDie(events.acknowledge(userId, Number.MAX_SAFE_INTEGER));
          return true;
        }
        while (true) {
          const pending = yield* Effect.orDie(events.pending(userId, DRIVE_EVENT_BATCH_SIZE));
          const through = pending.at(-1)?.sequence;
          if (through === undefined) return true;
          const batch = yield* Effect.orDie(Effect.forEach(pending, withCommits));
          const delivered = yield* users
            .forUser(userId)
            .driveEvents({ driveId, events: batch })
            .pipe(
              Effect.andThen(Effect.orDie(events.acknowledge(userId, through))),
              Effect.andThen(
                Metric.update(
                  Metric.withAttributes(deliveredEvents, { outcome: "delivered" }),
                  batch.length,
                ),
              ),
              Effect.as(true),
              Effect.catchTags({
                UserObjectError: (error) =>
                  Effect.logWarning("drive event delivery failed; will retry", {
                    driveId,
                    cause: error.cause,
                  }).pipe(
                    Effect.andThen(
                      Metric.update(
                        Metric.withAttributes(deliveredEvents, { outcome: "failed" }),
                        batch.length,
                      ),
                    ),
                    Effect.as(false),
                  ),
              }),
              // Who and where, never what (#284): ids only.
              Effect.withSpan("DriveObject.deliverEvents", {
                attributes: { "drive.id": driveId, "person.id": userId },
              }),
            );
          if (!delivered) return false;
        }
      });

    const recipients = yield* Effect.orDie(events.recipients);
    const results = yield* Effect.forEach(recipients, deliverTo, { concurrency: 4 });
    return results.every(Boolean);
  });
