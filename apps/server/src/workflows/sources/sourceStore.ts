import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** Storage for watched sources; storeSchema.ts creates the table. */

export interface SourceRow {
  readonly source_id: string;
  readonly project_id: string;
  /** The watch that first asked for it; its operation, args, key, items and connection are the source's. */
  readonly watch_json: string;
  /** Items by key from the last good read; null until the first one, which emits nothing. */
  readonly snapshot_json: string | null;
  /** The current check interval: the watchers' shortest `every`, longer while the source is quiet. */
  readonly interval_ms: number;
  readonly next_check_at: string;
  readonly last_checked_at: string | null;
  readonly last_changed_at: string | null;
  /** Failed reads in a row. */
  readonly failures: number;
  readonly last_error: string | null;
  /** Set after too many failed reads in a row; nothing reads it until a watcher is saved again. */
  readonly paused_at: string | null;
  /** The last time anyone watched it; sources nobody watches for a while are deleted. */
  readonly wanted_at: string;
  readonly created_at: string;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = <A>(operation: string, statement: Effect.Effect<A, SqlError>) =>
    statement.pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({ message: `Automation storage failed (${operation}).`, cause }),
      ),
    );

  return {
    /** When these are next due, for the tick: no snapshots. */
    schedule: (sourceIds: ReadonlyArray<string>) =>
      sourceIds.length === 0
        ? Effect.succeed([])
        : run(
            "sourceSchedule",
            sql<Pick<SourceRow, "source_id" | "paused_at" | "next_check_at" | "interval_ms">>`
              SELECT source_id, paused_at, next_check_at, interval_ms FROM signalbox_automation_sources
              WHERE ${sql.in("source_id", sourceIds)}
            `,
          ),
    /** How reading these goes, for views: no snapshots. */
    statuses: (sourceIds: ReadonlyArray<string>) =>
      sourceIds.length === 0
        ? Effect.succeed([])
        : run(
            "sourceStatuses",
            sql<Omit<SourceRow, "snapshot_json" | "watch_json"> & { readonly read: number }>`
              SELECT source_id, project_id, interval_ms, next_check_at, last_checked_at,
                last_changed_at, failures, last_error, paused_at, wanted_at, created_at,
                snapshot_json IS NOT NULL AS read
              FROM signalbox_automation_sources WHERE ${sql.in("source_id", sourceIds)}
            `,
          ),
    get: (sourceId: string) =>
      run(
        "getSource",
        sql<SourceRow>`SELECT * FROM signalbox_automation_sources WHERE source_id = ${sourceId}`,
      ).pipe(Effect.map((rows) => rows[0])),
    /** A source someone started watching; one already stored keeps its last read. */
    insert: (row: SourceRow) =>
      run(
        "insertSource",
        sql`
          INSERT INTO signalbox_automation_sources (
            source_id, project_id, watch_json, snapshot_json, interval_ms, next_check_at,
            last_checked_at, last_changed_at, failures, last_error, paused_at, wanted_at, created_at
          ) VALUES (
            ${row.source_id}, ${row.project_id}, ${row.watch_json}, ${row.snapshot_json},
            ${row.interval_ms}, ${row.next_check_at}, ${row.last_checked_at}, ${row.last_changed_at},
            ${row.failures}, ${row.last_error}, ${row.paused_at}, ${row.wanted_at}, ${row.created_at}
          )
          ON CONFLICT (source_id) DO NOTHING
        `,
      ),
    /** Someone still watches these. */
    wanted: (sourceIds: ReadonlyArray<string>, at: string) =>
      sourceIds.length === 0
        ? Effect.void
        : run(
            "wantSources",
            sql`UPDATE signalbox_automation_sources SET wanted_at = ${at}
              WHERE ${sql.in("source_id", sourceIds)}`,
          ).pipe(Effect.asVoid),
    /** A good read: the new snapshot (null when nothing changed), and when to look again. */
    recordRead: (input: {
      readonly sourceId: string;
      readonly snapshot: string | null;
      readonly intervalMs: number;
      readonly nextCheckAt: string;
      readonly checkedAt: string;
      readonly changed: boolean;
    }) =>
      run(
        "recordSourceRead",
        sql`
          UPDATE signalbox_automation_sources SET
            snapshot_json = ${input.snapshot === null ? sql`snapshot_json` : input.snapshot},
            interval_ms = ${input.intervalMs},
            next_check_at = ${input.nextCheckAt},
            last_checked_at = ${input.checkedAt},
            last_changed_at = ${input.changed ? input.checkedAt : sql`last_changed_at`},
            failures = 0,
            last_error = NULL
          WHERE source_id = ${input.sourceId}
        `,
      ).pipe(Effect.asVoid),
    /** A failed read: back off, or pause when `pause` says so. */
    recordFailure: (input: {
      readonly sourceId: string;
      /** Failed reads in a row, this one included. */
      readonly failures: number;
      readonly error: string;
      readonly nextCheckAt: string;
      readonly checkedAt: string;
      readonly pause: boolean;
    }) =>
      run(
        "recordSourceFailure",
        sql`
          UPDATE signalbox_automation_sources SET
            failures = ${input.failures},
            last_error = ${input.error},
            last_checked_at = ${input.checkedAt},
            next_check_at = ${input.nextCheckAt},
            paused_at = ${input.pause ? input.checkedAt : null}
          WHERE source_id = ${input.sourceId}
        `,
      ).pipe(Effect.asVoid),
    /** Lifts a pause; the next tick reads it. */
    resume: (sourceId: string, at: string) =>
      run(
        "resumeSource",
        sql`
          UPDATE signalbox_automation_sources
          SET paused_at = NULL, failures = 0, next_check_at = ${at}
          WHERE source_id = ${sourceId} AND paused_at IS NOT NULL
        `,
      ).pipe(Effect.asVoid),
    /** Sources nobody watched since `before`. */
    prune: (before: string) =>
      run(
        "pruneSources",
        sql`DELETE FROM signalbox_automation_sources WHERE wanted_at < ${before}`,
      ).pipe(Effect.asVoid),
  };
});

export type SourceStore = Effect.Success<typeof make>;
