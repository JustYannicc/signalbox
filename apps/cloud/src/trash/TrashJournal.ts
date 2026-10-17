import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows, encodePlannedRemovals, encodeTargets } from "./trashTables.ts";
import type { FolderTrash } from "./TrashResources.ts";
import type { PlannedRemoval, Row } from "./trashTables.ts";

const encodeDriveIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const makeJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    query.pipe(Effect.map(decodeRows));
  const read = (id: string) =>
    rows(sql`SELECT * FROM trash_entries WHERE id = ${id}`).pipe(
      Effect.map((entries) => entries[0] ?? null),
    );
  const active = (kind: Row["kind"], targetId: string) =>
    rows(sql`SELECT * FROM trash_entries
    WHERE kind = ${kind} AND target_id = ${targetId}
      AND status IN ('trashed', 'restoring', 'purging')`).pipe(
      Effect.map((entries) => entries[0] ?? null),
    );
  const request = (commandId: string) =>
    sql<{
      readonly kind: Row["kind"];
      readonly target_id: string;
      readonly trash_id: string;
    }>`SELECT kind, target_id, trash_id FROM trash_requests WHERE command_id = ${commandId}`.pipe(
      Effect.map((entries) => entries[0] ?? null),
    );
  const rememberRequest = (
    commandId: string,
    kind: Row["kind"],
    targetId: string,
    trashId: string,
  ) =>
    sql`INSERT INTO trash_requests (command_id, kind, target_id, trash_id)
      VALUES (${commandId}, ${kind}, ${targetId}, ${trashId}) ON CONFLICT (command_id) DO NOTHING`;
  const put = (
    entry: FolderTrash & {
      readonly kind: Row["kind"];
      readonly targetId: string;
      readonly plannedRemovals: ReadonlyArray<PlannedRemoval>;
      readonly commandId?: string;
    },
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO trash_entries
      (id, kind, target_id, title, context_id, deleted_at, purge_after, status, targets, drive_ids,
        planned_removals)
      VALUES (${entry.id}, ${entry.kind}, ${entry.targetId}, ${entry.title}, ${entry.contextId},
        ${entry.deletedAt}, ${entry.purgeAfter}, 'trashed', ${encodeTargets(entry.targets)},
        ${encodeDriveIds(entry.driveIds)}, ${encodePlannedRemovals(entry.plannedRemovals)})
      ON CONFLICT (id) DO NOTHING`;
        if (entry.commandId !== undefined)
          yield* rememberRequest(entry.commandId, entry.kind, entry.targetId, entry.id);
      }),
    );
  return {
    read,
    request,
    rememberRequest,
    active,
    put,
    all: rows(sql`SELECT * FROM trash_entries ORDER BY deleted_at DESC, id DESC`),
    pending:
      rows(sql`SELECT * FROM trash_entries WHERE status IN ('trashed', 'restoring', 'purging')
      OR (status = 'purged' AND gc_after IS NOT NULL) ORDER BY deleted_at, id`),
    scheduled: (id: string) => sql`UPDATE trash_entries SET scheduled = 1 WHERE id = ${id}`,
    prepared: (id: string) =>
      sql`UPDATE trash_entries SET prepared = 1, error = NULL WHERE id = ${id}`,
    error: (id: string, error: string | null) =>
      sql`UPDATE trash_entries SET error = ${error} WHERE id = ${id}`,
    restore: (id: string, now: number) =>
      sql`UPDATE trash_entries
      SET status = 'restoring', error = NULL, restore_started_at = ${now}
      WHERE id = ${id} AND status = 'trashed' AND purge_after > ${now} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    restored: (id: string) => sql`UPDATE trash_entries SET status = 'restored', error = NULL
      WHERE id = ${id} AND status = 'restoring'`,
  };
});
