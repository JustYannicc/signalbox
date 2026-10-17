// @effect-diagnostics anyUnknownInErrorContext:off - Migrator models migration failures broadly.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as Migrations from "../../storage/migrations.ts";
import * as SearchIndex from "../SearchIndex.ts";
import * as SqliteSearchQueries from "./SqliteSearchQueries.ts";

const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const migrations = Migrator.fromRecord({
  "0001_thread_search": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE search_home (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE search_threads (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      source_sequence INTEGER NOT NULL,
      complete INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE search_documents (
      id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES search_threads(thread_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      run_id TEXT,
      position REAL NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      literal_text TEXT NOT NULL,
      created_at TEXT,
      revision INTEGER NOT NULL,
      UNIQUE (thread_id, item_id)
    )`;
    yield* sql`CREATE INDEX search_documents_order
      ON search_documents(thread_id, item_id)`;
    yield* sql`CREATE TABLE search_tombstones (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    )`;
    yield* sql`CREATE TABLE search_delivery_receipts (
      delivery_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (thread_id, delivery_id)
    )`;
    // Content is maintained explicitly in the same SQLite transaction as each document change.
    yield* sql`CREATE VIRTUAL TABLE search_documents_fts USING fts5(
      search_text, tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_'''
    )`;
  }),
});
const matchesHome = (expected: SearchIndex.SearchHome, actual: SearchIndex.SearchHome) =>
  expected.ownerId === actual.ownerId && expected.projectId === actual.projectId;

const failHome = (operation: string) =>
  new SearchIndex.SearchIndexError({
    operation,
    cause: new Error("Search home does not match this index."),
  });

const make = (home: SearchIndex.SearchHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const deliver = (delivery: SearchIndex.SearchDelivery) => {
      if (!matchesHome(home, delivery.home)) return Effect.fail(failHome("deliver"));
      if (delivery.documents.some((document) => document.threadId !== delivery.thread.threadId)) {
        return Effect.fail(
          new SearchIndex.SearchIndexError({
            operation: "deliver",
            cause: new Error("A delivery may only contain documents for its thread."),
          }),
        );
      }
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const receipts = yield* sql<{ readonly delivery_id: string }>`SELECT delivery_id
            FROM search_delivery_receipts
            WHERE thread_id = ${delivery.thread.threadId} AND delivery_id = ${delivery.deliveryId}`;
            if (receipts.length > 0) return;

            const current = yield* sql<{ readonly revision: number }>`SELECT revision
            FROM search_threads WHERE thread_id = ${delivery.thread.threadId}`;
            const currentRevision = current[0]?.revision;
            const stale = currentRevision !== undefined && delivery.revision < currentRevision;

            if (!stale) {
              const newer = currentRevision === undefined || delivery.revision > currentRevision;
              yield* sql`INSERT INTO search_threads
              (thread_id, title, archived, deleted, revision, source_sequence, complete)
              VALUES (
                ${delivery.thread.threadId}, ${delivery.thread.title},
                ${delivery.thread.archived ? 1 : 0}, ${delivery.thread.deleted ? 1 : 0},
                ${delivery.revision}, ${delivery.sourceSequence}, ${delivery.complete ? 1 : 0}
              )
              ON CONFLICT(thread_id) DO UPDATE SET
                title = excluded.title,
                archived = excluded.archived,
                deleted = excluded.deleted,
                revision = excluded.revision,
                source_sequence = excluded.source_sequence,
                complete = MAX(search_threads.complete, excluded.complete)`;

              for (const document of delivery.documents) {
                const tombstones = yield* sql<{ readonly revision: number }>`SELECT revision
                FROM search_tombstones WHERE thread_id = ${document.threadId}
                  AND item_id = ${document.itemId}`;
                if (tombstones[0] !== undefined && tombstones[0].revision >= delivery.revision)
                  continue;

                const previous = yield* sql<{
                  readonly id: number;
                  readonly revision: number;
                }>`SELECT id, revision FROM search_documents
                WHERE thread_id = ${document.threadId} AND item_id = ${document.itemId}`;
                const existingRow = previous[0];
                if (existingRow !== undefined && existingRow.revision > delivery.revision) continue;
                const existingId = existingRow?.id;
                if (existingId !== undefined) {
                  yield* sql`DELETE FROM search_documents_fts WHERE rowid = ${existingId}`;
                }
                yield* sql`INSERT INTO search_documents
                (thread_id, item_id, entry_id, run_id, position, kind, text, search_text, literal_text, created_at, revision)
                VALUES (
                  ${document.threadId}, ${document.itemId}, ${document.entryId}, ${document.runId},
                  ${document.position}, ${document.kind}, ${document.text},
                  ${SqliteSearchQueries.normalizeKeywordText(document.text)},
                  ${SqliteSearchQueries.foldLiteralText(document.text)}, ${document.createdAt},
                  ${delivery.revision}
                )
                ON CONFLICT(thread_id, item_id) DO UPDATE SET
                  entry_id = excluded.entry_id,
                  run_id = excluded.run_id,
                  position = excluded.position,
                  kind = excluded.kind,
                  text = excluded.text,
                  search_text = excluded.search_text,
                  literal_text = excluded.literal_text,
                  created_at = excluded.created_at,
                  revision = excluded.revision
                WHERE excluded.revision >= search_documents.revision`;
                const inserted = yield* sql<{ readonly id: number }>`SELECT id FROM search_documents
                WHERE thread_id = ${document.threadId} AND item_id = ${document.itemId}`;
                const rowId = inserted[0]?.id;
                if (rowId !== undefined) {
                  yield* sql`INSERT INTO search_documents_fts (rowid, search_text)
                  VALUES (${rowId}, ${SqliteSearchQueries.normalizeKeywordText(document.text)})`;
                }
                // A newer source revision is the only event that can resurrect a removed item.
                if (newer) {
                  yield* sql`DELETE FROM search_tombstones
                  WHERE thread_id = ${document.threadId} AND item_id = ${document.itemId}
                    AND revision < ${delivery.revision}`;
                }
              }

              for (const itemId of delivery.removed) {
                const previous = yield* sql<{ readonly id: number }>`SELECT id FROM search_documents
                WHERE thread_id = ${delivery.thread.threadId} AND item_id = ${itemId}`;
                const rowId = previous[0]?.id;
                if (rowId !== undefined) {
                  yield* sql`DELETE FROM search_documents_fts WHERE rowid = ${rowId}`;
                  yield* sql`DELETE FROM search_documents
                  WHERE thread_id = ${delivery.thread.threadId} AND item_id = ${itemId}`;
                }
                yield* sql`INSERT INTO search_tombstones (thread_id, item_id, revision)
                VALUES (${delivery.thread.threadId}, ${itemId}, ${delivery.revision})
                ON CONFLICT(thread_id, item_id) DO UPDATE SET
                  revision = MAX(search_tombstones.revision, excluded.revision)`;
              }
            }

            yield* sql`INSERT INTO search_delivery_receipts (delivery_id, thread_id, revision)
            VALUES (${delivery.deliveryId}, ${delivery.thread.threadId}, ${delivery.revision})`;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            Schema.is(SearchIndex.SearchIndexError)(cause)
              ? cause
              : new SearchIndex.SearchIndexError({ operation: "deliver", cause }),
          ),
        );
    };

    const query: SearchIndex.SearchIndex["Service"]["query"] = (input) => {
      if (!matchesHome(home, input.home)) return Effect.fail(failHome("query"));
      return SqliteSearchQueries.query(sql, input).pipe(
        Effect.mapError((cause) => new SearchIndex.SearchIndexError({ operation: "query", cause })),
      );
    };

    const progress: SearchIndex.SearchIndex["Service"]["progress"] = (requestedHome, threadIds) => {
      if (!matchesHome(home, requestedHome)) return Effect.fail(failHome("progress"));
      if (threadIds.length === 0) return Effect.succeed([]);
      return sql<{
        readonly threadId: string;
        readonly revision: number;
        readonly complete: number;
      }>`SELECT thread_id AS threadId, revision, complete
        FROM search_threads
        WHERE thread_id IN (SELECT value FROM json_each(${encodeStrings(threadIds)}))
        ORDER BY thread_id COLLATE BINARY`.pipe(
        Effect.map((rows) => rows.map((row) => ({ ...row, complete: row.complete === 1 }))),
        Effect.mapError(
          (cause) => new SearchIndex.SearchIndexError({ operation: "progress", cause }),
        ),
      );
    };

    return SearchIndex.SearchIndex.of({ deliver, query, progress });
  });

/** Initializes the named additive migration and binds the object to one search home. */
export const initialize = (home: SearchIndex.SearchHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrations.run(migrations);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO search_home (id, owner_id, project_id)
        VALUES (1, ${home.ownerId}, ${home.projectId}) ON CONFLICT(id) DO NOTHING`;
        const rows = yield* sql<{
          readonly owner_id: string;
          readonly project_id: string;
        }>`SELECT owner_id, project_id
        FROM search_home WHERE id = 1`;
        if (rows[0]?.owner_id !== home.ownerId || rows[0]?.project_id !== home.projectId) {
          return yield* failHome("initialize");
        }
      }),
    );
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(SearchIndex.SearchIndexError)(cause)
        ? cause
        : new SearchIndex.SearchIndexError({ operation: "initialize", cause }),
    ),
  );

export const layer = (home: SearchIndex.SearchHome) =>
  Layer.effect(SearchIndex.SearchIndex, make(home));
