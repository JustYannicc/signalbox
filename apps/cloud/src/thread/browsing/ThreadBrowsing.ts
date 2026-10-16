import { applyBrowsingEvent } from "@t3tools/client-runtime/browsing";
import {
  type BrowsingCommand,
  BrowsingEvent,
  type BrowsingMember,
  BrowsingRecord,
  type BrowsingStreamItem,
  type BrowsingTab,
  EMPTY_BROWSING_RECORD,
} from "@t3tools/contracts/signalboxBrowsing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { type Actor, ThreadEngine, ThreadNotFoundError } from "../ThreadEngine.ts";
import { decideBrowsing } from "./browsingDecider.ts";

/**
 * A thread's browsing log (#585), inside its Durable Object beside the
 * conversation's. Commands run one at a time: decide against the record,
 * commit the events with the record they leave, then publish them. A
 * subscriber gets the record and then every event after it, so it never needs
 * a replay. The record is the source of truth; the log keeps the recent
 * changes for tracing who did what, and is trimmed so scrolling can't grow it
 * without bound.
 */

/** How many recent events the log keeps; the record holds everything before. */
const KEPT_EVENTS = 2_000;
/** Trimming runs this often rather than on every scroll report. */
const TRIM_EVERY = 100;

/** The record's sequence after a command, and the tab it named as it is now (null once closed). */
export interface BrowsingDispatched {
  readonly sequence: number;
  readonly tab: BrowsingTab | null;
}

export class BrowsingRejectedError extends Schema.TaggedError<BrowsingRejectedError>()(
  "BrowsingRejectedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

interface Head {
  readonly sequence: number;
  readonly record: BrowsingRecord;
}

export class ThreadBrowsing extends Context.Service<
  ThreadBrowsing,
  {
    /** The record, then each batch of events. Fails with not-found unless `actor` can see the thread. */
    readonly subscribe: (
      actor: Actor,
      you: BrowsingMember,
    ) => Effect.Effect<Stream.Stream<ReadonlyArray<BrowsingStreamItem>>, ThreadNotFoundError>;
    /** Applies `command` as `by`; the record's sequence after it. */
    readonly dispatch: (
      actor: Actor,
      by: BrowsingMember,
      command: BrowsingCommand,
    ) => Effect.Effect<BrowsingDispatched, ThreadNotFoundError | BrowsingRejectedError>;
    /** The record as of now, for the preview panel's list. */
    readonly record: (actor: Actor) => Effect.Effect<Head, ThreadNotFoundError>;
  }
>()("@signalbox/cloud/thread/browsing/ThreadBrowsing") {}

const RecordJson = Schema.fromJsonString(BrowsingRecord);
const encodeRecord = Schema.encodeSync(RecordJson);
const decodeRecordRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ sequence: Schema.Number, record: RecordJson })),
);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(BrowsingEvent));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* ThreadEngine;
  const lock = yield* Semaphore.make(1);
  const published = yield* PubSub.unbounded<ReadonlyArray<BrowsingStreamItem>>();
  // Loaded on first use: most threads never browse, and their objects shouldn't read for it.
  const head = yield* Ref.make<Head | null>(null);

  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const visible = (actor: Actor) =>
    Effect.flatMap(engine.canSee(actor), (canSee) =>
      canSee ? Effect.void : Effect.fail(new ThreadNotFoundError()),
    );

  const current = Effect.gen(function* () {
    const loaded = yield* Ref.get(head);
    if (loaded !== null) return loaded;
    const rows = yield* Effect.orDie(
      sql`SELECT sequence, record FROM browsing_record WHERE id = 1`,
    );
    const stored = decodeRecordRows(rows)[0];
    const next: Head = stored ?? { sequence: 0, record: EMPTY_BROWSING_RECORD };
    yield* Ref.set(head, next);
    return next;
  });

  const commit = (events: ReadonlyArray<BrowsingEvent>, next: Head) =>
    Effect.orDie(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const event of events) {
            yield* sql`INSERT INTO browsing_events (sequence, event)
              VALUES (${event.sequence}, ${encodeEvent(event)})`;
          }
          yield* sql`INSERT INTO browsing_record (id, sequence, record)
            VALUES (1, ${next.sequence}, ${encodeRecord(next.record)})
            ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence, record = excluded.record`;
          if (
            Math.floor(next.sequence / TRIM_EVERY) >
            Math.floor((next.sequence - events.length) / TRIM_EVERY)
          ) {
            yield* sql`DELETE FROM browsing_events WHERE sequence <= ${next.sequence - KEPT_EVENTS}`;
          }
        }),
      ),
    );

  const dispatch: ThreadBrowsing["Service"]["dispatch"] = (actor, by, command) =>
    Effect.andThen(
      visible(actor),
      serialized(
        Effect.gen(function* () {
          const { sequence, record } = yield* current;
          const at = DateTime.formatIso(yield* DateTime.now);
          const decision = decideBrowsing(record, command, { by, at, sequence });
          if (decision._tag === "Rejected") {
            return yield* new BrowsingRejectedError({ reason: decision.reason });
          }
          const { events } = decision;
          const tabAfter = (state: BrowsingRecord) =>
            "tabId" in command
              ? (state.tabs.find((tab) => tab.id === command.tabId) ?? null)
              : null;
          const last = events.at(-1);
          if (last === undefined) return { sequence, tab: tabAfter(record) };
          const next: Head = {
            sequence: last.sequence,
            record: events.reduce(applyBrowsingEvent, record),
          };
          yield* commit(events, next);
          yield* Ref.set(head, next);
          yield* PubSub.publish(
            published,
            events.map((event): BrowsingStreamItem => ({ _tag: "Event", event })),
          );
          return { sequence: next.sequence, tab: tabAfter(next.record) };
        }),
      ),
    );

  const subscribe: ThreadBrowsing["Service"]["subscribe"] = (actor, you) =>
    Effect.andThen(
      visible(actor),
      serialized(
        Effect.gen(function* () {
          const { sequence, record } = yield* current;
          // Subscribed under the lock, so no commit lands between the snapshot and the tail.
          const scope = yield* Scope.make();
          const subscription = yield* PubSub.subscribe(published).pipe(Scope.provide(scope));
          const snapshot: BrowsingStreamItem = { _tag: "Snapshot", sequence, record, you };
          return Stream.concat(Stream.make([snapshot]), Stream.fromSubscription(subscription)).pipe(
            Stream.ensuring(Scope.close(scope, Exit.void)),
          );
        }),
      ),
    );

  const recordOf: ThreadBrowsing["Service"]["record"] = (actor) =>
    Effect.andThen(visible(actor), serialized(current));

  return ThreadBrowsing.of({ subscribe, dispatch, record: recordOf });
});

export const layer = Layer.effect(ThreadBrowsing, make);
