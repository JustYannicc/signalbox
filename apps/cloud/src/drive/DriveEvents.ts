import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { parseDriveId } from "./driveAccess.ts";

/**
 * A drive's changes, for its people's automations (#471): every move of
 * `main` and of a thread's branch, in order, with an outbox entry per person
 * who could open the drive when it moved. The drive object's alarm delivers
 * them (`driveEventOutbox.ts`) and each person's object drops what it already
 * took, the same at-least-once path thread events take. Auto-saves and
 * machine state never count: they aren't work anyone landed.
 */

/** One ref move as a person's object receives it (`UserObjectApi.driveEvents`). */
export const DriveRefEvent = Schema.Struct({
  /** Grows with every move in this drive; never reused. */
  sequence: Schema.Number,
  ref: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.String,
  /** The thread that moved it; null when a person did (starting or splitting a drive). */
  threadId: Schema.NullOr(Schema.String),
  /** Milliseconds since the epoch. */
  at: Schema.Number,
  /** New since `before`, newest first. */
  commits: Schema.Array(
    Schema.Struct({
      oid: Schema.String,
      author: Schema.String,
      message: Schema.String,
      parents: Schema.Array(Schema.String),
    }),
  ),
  commitsTruncated: Schema.Boolean,
});
export type DriveRefEvent = typeof DriveRefEvent.Type;

/** A recorded move, before its commits are read. */
export interface RefMove {
  readonly sequence: number;
  readonly ref: string;
  readonly before: string | null;
  readonly after: string;
  readonly threadId: string | null;
  readonly at: number;
}

export class DriveEvents extends Context.Service<
  DriveEvents,
  {
    /** Records a move for everyone in the drive now. Runs inside the move's transaction. */
    readonly record: (move: Omit<RefMove, "sequence" | "at">) => Effect.Effect<void, SqlError>;
    /** Whose deliveries are waiting. */
    readonly recipients: Effect.Effect<ReadonlyArray<string>, SqlError>;
    /** `userId`'s next undelivered moves, oldest first. */
    readonly pending: (
      userId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<RefMove>, SqlError>;
    /** `userId` took everything through `sequence`; moves nobody waits on any more go. */
    readonly acknowledge: (userId: string, sequence: number) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/drive/DriveEvents") {}

/** Part of `DriveStore`'s `0006` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE ref_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    before TEXT,
    after TEXT NOT NULL,
    thread_id TEXT,
    at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE ref_event_deliveries (
    user_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (user_id, seq)
  )`;
  yield* sql`CREATE INDEX ref_event_deliveries_seq ON ref_event_deliveries (seq)`;
});

/** Moves a person's backlog keeps while their object can't take them; older ones go. */
export const BACKLOG = 1_000;

const decodeMoves = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      ref: Schema.String,
      before: Schema.NullOr(Schema.String),
      after: Schema.String,
      thread_id: Schema.NullOr(Schema.String),
      at: Schema.Number,
    }),
  ),
);

/** `driveId` is the object's own name, which names a My Drive's owner. */
export const layer = (driveId: string) =>
  Layer.effect(
    DriveEvents,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const owner = parseDriveId(driveId)?.owner ?? null;

      const record: DriveEvents["Service"]["record"] = (move) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const [row] = yield* sql<{ readonly seq: number }>`INSERT INTO ref_events
            (ref, before, after, thread_id, at)
            VALUES (${move.ref}, ${move.before}, ${move.after}, ${move.threadId}, ${at})
            RETURNING seq`;
          const seq = row!.seq;
          // Everyone in the drive now; a My Drive's owner is named by its id, not a member row.
          yield* sql`INSERT OR IGNORE INTO ref_event_deliveries (user_id, seq)
            SELECT user_id, ${seq} FROM members WHERE role IS NOT NULL
            UNION SELECT ${owner}, ${seq} WHERE ${owner} IS NOT NULL`;
          // A person whose object keeps failing loses their oldest moves, not the drive its space.
          yield* sql`DELETE FROM ref_event_deliveries WHERE seq <= ${seq - BACKLOG}`;
          yield* sql`DELETE FROM ref_events WHERE seq <= ${seq - BACKLOG}`;
          yield* sql`DELETE FROM ref_events WHERE seq = ${seq}
            AND NOT EXISTS (SELECT 1 FROM ref_event_deliveries WHERE seq = ${seq})`;
        });

      const recipients: DriveEvents["Service"]["recipients"] = sql<{
        readonly user_id: string;
      }>`SELECT DISTINCT user_id FROM ref_event_deliveries ORDER BY user_id`.pipe(
        Effect.map((rows) => rows.map((row) => row.user_id)),
      );

      const pending: DriveEvents["Service"]["pending"] = (userId, limit) =>
        sql`SELECT e.seq, e.ref, e.before, e.after, e.thread_id, e.at
          FROM ref_event_deliveries d JOIN ref_events e ON e.seq = d.seq
          WHERE d.user_id = ${userId} ORDER BY e.seq LIMIT ${limit}`.pipe(
          Effect.map((rows) =>
            decodeMoves(rows).map((row) => ({
              sequence: row.seq,
              ref: row.ref,
              before: row.before,
              after: row.after,
              threadId: row.thread_id,
              at: row.at,
            })),
          ),
        );

      const acknowledge: DriveEvents["Service"]["acknowledge"] = (userId, sequence) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM ref_event_deliveries WHERE user_id = ${userId} AND seq <= ${sequence}`;
          yield* sql`DELETE FROM ref_events WHERE seq <= ${sequence}
            AND NOT EXISTS (SELECT 1 FROM ref_event_deliveries d WHERE d.seq = ref_events.seq)`;
        }).pipe(sql.withTransaction);

      return DriveEvents.of({ record, recipients, pending, acknowledge });
    }),
  );
