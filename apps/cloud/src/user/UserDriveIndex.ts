import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import { SignalboxDriveRole as RoleSchema } from "@t3tools/contracts/signalboxDrives";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The drives other people gave a user, in the user's own object: shared
 * drives they're a member of and folders shared with them. Each drive's object
 * delivers its membership changes here (`drive/driveAccessOutbox.ts`), so the
 * index is derived; it only lists drives. Whether the user may actually open
 * one is always asked of the drive itself.
 */

/** One drive's delivery: the user's role, or null once they're out. */
export interface DriveAccessEntry {
  readonly driveId: string;
  readonly name: string;
  readonly role: SignalboxDriveRole | null;
  /** Who added them, for Shared with me. */
  readonly sharedBy: string | null;
  /** The drive's revision of this membership; only a newer one changes the row. */
  readonly revision: number;
}

export interface IndexedDrive {
  readonly driveId: string;
  readonly name: string;
  readonly role: SignalboxDriveRole;
  readonly sharedBy: string | null;
}

export class UserDriveIndex extends Context.Service<
  UserDriveIndex,
  {
    /** Idempotent: an old or repeated revision changes nothing. */
    readonly record: (entry: DriveAccessEntry) => Effect.Effect<void, SqlError>;
    /** Drives the user is in now. */
    readonly drives: Effect.Effect<ReadonlyArray<IndexedDrive>, SqlError>;
    /** Grows with every change; persisted. */
    readonly revision: Effect.Effect<number, SqlError>;
    readonly changed: Stream.Stream<void>;
  }
>()("@signalbox/cloud/user/UserDriveIndex") {}

/** Part of `UserStore`'s drives migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_access (
    drive_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT,
    shared_by TEXT,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE drive_access_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO drive_access_state (id, revision) VALUES (1, 0)`;
});

const DriveRow = Schema.Struct({
  drive_id: Schema.String,
  name: Schema.String,
  role: RoleSchema,
  shared_by: Schema.NullOr(Schema.String),
});
const decodeDriveRows = Schema.decodeUnknownSync(Schema.Array(DriveRow));

export const layer = Layer.effect(
  UserDriveIndex,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Sliding at one: a subscriber that falls behind needs only the latest state.
    const changed = yield* PubSub.sliding<void>(1);

    const record: UserDriveIndex["Service"]["record"] = (entry) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const written = yield* sql`INSERT INTO drive_access
            (drive_id, name, role, shared_by, revision, updated_at)
          VALUES (${entry.driveId}, ${entry.name}, ${entry.role}, ${entry.sharedBy},
            ${entry.revision}, ${now})
          ON CONFLICT (drive_id) DO UPDATE SET name = excluded.name, role = excluded.role,
            shared_by = excluded.shared_by, revision = excluded.revision,
            updated_at = excluded.updated_at
          WHERE excluded.revision > drive_access.revision
          RETURNING drive_id`;
        if (written.length === 0) return false;
        yield* sql`UPDATE drive_access_state SET revision = revision + 1 WHERE id = 1`;
        return true;
      }).pipe(
        sql.withTransaction,
        Effect.flatMap((wrote) => (wrote ? PubSub.publish(changed, undefined) : Effect.void)),
        Effect.asVoid,
      );

    const drives: UserDriveIndex["Service"]["drives"] = sql`SELECT drive_id, name, role, shared_by
      FROM drive_access WHERE role IS NOT NULL ORDER BY name COLLATE NOCASE, drive_id`.pipe(
      Effect.map((rows) =>
        decodeDriveRows(rows).map((row) => ({
          driveId: row.drive_id,
          name: row.name,
          role: row.role,
          sharedBy: row.shared_by,
        })),
      ),
    );

    const revision: UserDriveIndex["Service"]["revision"] = sql<{
      readonly revision: number;
    }>`SELECT revision FROM drive_access_state WHERE id = 1`.pipe(
      Effect.map(([row]) => row?.revision ?? 0),
    );

    return UserDriveIndex.of({ record, drives, revision, changed: Stream.fromPubSub(changed) });
  }),
);
