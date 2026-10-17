// @effect-diagnostics anyUnknownInErrorContext:off - Migrator models migration failures broadly.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as Migrations from "../../storage/migrations.ts";
import * as SearchIndex from "../SearchIndex.ts";
import * as SqliteSearchParts from "./SqliteSearchParts.ts";
import * as SqliteSearchQueries from "./SqliteSearchQueries.ts";
import * as SqliteSearchSnapshots from "./SqliteSearchSnapshots.ts";

const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isSearchIndexError = Schema.is(SearchIndex.SearchIndexError);
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
  "0002_bounded_search_document_parts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE search_threads ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`;
    yield* sql`ALTER TABLE search_threads ADD COLUMN complete_requested INTEGER NOT NULL DEFAULT 0`;
    yield* sql`CREATE TABLE search_document_parts (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
      part_index INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      total_length INTEGER NOT NULL,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL,
      literal_text TEXT NOT NULL,
      UNIQUE (document_id, part_index),
      UNIQUE (document_id, offset)
    )`;
    yield* sql`CREATE TABLE search_document_staging (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      run_id TEXT,
      position REAL NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT,
      total_length INTEGER NOT NULL,
      invalid INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, item_id, revision)
    )`;
    yield* sql`CREATE TABLE search_document_staging_parts (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id, revision, offset),
      FOREIGN KEY (thread_id, item_id, revision)
        REFERENCES search_document_staging(thread_id, item_id, revision) ON DELETE CASCADE
    )`;
    yield* sql`CREATE VIRTUAL TABLE search_document_parts_fts USING fts5(
      search_text, tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_'''
    )`;
  }),
  "0003_per_document_source_sequence_and_conversion": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE search_documents ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0`;
    yield* sql`ALTER TABLE search_document_staging ADD COLUMN source_sequence INTEGER`;
    yield* sql`ALTER TABLE search_document_parts ADD COLUMN unit_length INTEGER NOT NULL DEFAULT 0`;
    yield* sql`CREATE TABLE search_document_conversion (
      document_id INTEGER PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
      char_offset INTEGER NOT NULL,
      unit_offset INTEGER NOT NULL,
      total_chars INTEGER NOT NULL,
      total_length INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('reading', 'indexing', 'verifying', 'invalid')),
      next_part_index INTEGER NOT NULL,
      next_index_part INTEGER NOT NULL
    )`;
  }),
  "0004_authoritative_search_snapshots": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE search_thread_snapshots (
      thread_id TEXT PRIMARY KEY,
      activation TEXT NOT NULL,
      revision INTEGER NOT NULL,
      final_page INTEGER,
      complete INTEGER NOT NULL DEFAULT 0,
      covered_revision INTEGER NOT NULL DEFAULT 0
    )`;
    yield* sql`CREATE TABLE search_snapshot_pages (
      thread_id TEXT NOT NULL,
      activation TEXT NOT NULL,
      revision INTEGER NOT NULL,
      page INTEGER NOT NULL,
      final INTEGER NOT NULL,
      PRIMARY KEY (thread_id, activation, revision, page)
    )`;
    yield* sql`CREATE TABLE search_snapshot_items (
      thread_id TEXT NOT NULL,
      activation TEXT NOT NULL,
      revision INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, activation, revision, item_id)
    )`;
    yield* sql`CREATE TABLE search_thread_coverage_gaps (
      thread_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL
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

    const clearIndexedParts = (documentId: number) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM search_documents_fts WHERE rowid = ${documentId}`;
        yield* SqliteSearchParts.deleteIndexedParts(sql, documentId);
        yield* sql`DELETE FROM search_document_conversion WHERE document_id = ${documentId}`;
      });

    const recordReceipt = (delivery: SearchIndex.SearchDelivery) =>
      sql`INSERT INTO search_delivery_receipts (delivery_id, thread_id, revision)
        VALUES (${delivery.deliveryId}, ${delivery.thread.threadId}, ${delivery.revision})`;

    const deliver = (delivery: SearchIndex.SearchDelivery) => {
      if (!matchesHome(home, delivery.home)) return Effect.fail(failHome("deliver"));
      if (
        delivery.coverageGap === true &&
        (delivery.documents.length > 0 ||
          (delivery.parts?.length ?? 0) > 0 ||
          delivery.removed.length > 0 ||
          delivery.snapshot !== undefined)
      ) {
        return Effect.fail(
          new SearchIndex.SearchIndexError({
            operation: "deliver",
            cause: new Error("A coverage gap must not contain search document data."),
          }),
        );
      }
      if (
        delivery.documents.some((document) => document.threadId !== delivery.thread.threadId) ||
        (delivery.parts ?? []).some((part) => part.threadId !== delivery.thread.threadId)
      ) {
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

            if (delivery.coverageGap === true) {
              yield* SqliteSearchSnapshots.recordCoverageGap(sql, delivery);
              yield* recordReceipt(delivery);
              return;
            }

            const current = yield* sql<{ readonly revision: number }>`SELECT revision
            FROM search_threads WHERE thread_id = ${delivery.thread.threadId}`;
            const currentRevision = current[0]?.revision;
            const stale = currentRevision !== undefined && delivery.revision < currentRevision;
            const snapshot =
              delivery.snapshot === undefined
                ? undefined
                : { ...delivery.snapshot, revision: delivery.revision };
            const acceptedSnapshot =
              snapshot === undefined
                ? false
                : yield* SqliteSearchSnapshots.acceptActivation(
                    sql,
                    delivery.thread.threadId,
                    snapshot,
                  );
            const shouldProcess = snapshot === undefined ? !stale : acceptedSnapshot;

            if (shouldProcess) {
              // An older but valid snapshot still contributes membership and coverage after
              // newer live updates arrive. Its metadata must never roll those updates back.
              if (!stale) {
                const complete = snapshot === undefined && delivery.complete;
                yield* sql`INSERT INTO search_threads
              (thread_id, title, archived, deleted, revision, source_sequence, complete,
                updated_at, complete_requested)
              VALUES (
                ${delivery.thread.threadId}, ${delivery.thread.title},
                ${delivery.thread.archived ? 1 : 0}, ${delivery.thread.deleted ? 1 : 0},
                ${delivery.revision}, ${delivery.sourceSequence}, 0,
                ${delivery.thread.updatedAt ?? ""}, ${complete ? 1 : 0}
              )
              ON CONFLICT(thread_id) DO UPDATE SET
                title = excluded.title,
                archived = excluded.archived,
                deleted = excluded.deleted,
                revision = excluded.revision,
                source_sequence = excluded.source_sequence,
                updated_at = excluded.updated_at,
                complete = MAX(search_threads.complete, excluded.complete),
                complete_requested = MAX(search_threads.complete_requested, excluded.complete_requested)`;
              }

              const incomingParts: Array<SearchIndex.SearchDocumentPart> = [
                ...delivery.documents.flatMap((document) =>
                  SqliteSearchParts.splitDocument(document).map((piece) => ({
                    ...document,
                    ...piece,
                  })),
                ),
                ...(delivery.parts ?? []).flatMap(SqliteSearchParts.boundPart),
              ];
              for (const part of incomingParts) {
                yield* SqliteSearchParts.stagePart(
                  sql,
                  part,
                  delivery.revision,
                  delivery.sourceSequence,
                );
              }

              if (snapshot !== undefined) {
                const itemIds = [
                  ...new Set([
                    ...delivery.documents.map((document) => document.itemId),
                    ...(delivery.parts ?? []).map((part) => part.itemId),
                  ]),
                ];
                yield* SqliteSearchSnapshots.recordItems(
                  sql,
                  delivery.thread.threadId,
                  snapshot,
                  itemIds,
                );
                yield* SqliteSearchSnapshots.commitIfCovered(
                  sql,
                  delivery.thread.threadId,
                  snapshot,
                );
              } else {
                for (const itemId of delivery.removed) {
                  const previous = yield* sql<{
                    readonly id: number;
                  }>`SELECT id FROM search_documents
                  WHERE thread_id = ${delivery.thread.threadId} AND item_id = ${itemId}`;
                  const documentId = previous[0]?.id;
                  if (documentId !== undefined) {
                    yield* clearIndexedParts(documentId);
                    yield* sql`DELETE FROM search_documents
                    WHERE thread_id = ${delivery.thread.threadId} AND item_id = ${itemId}`;
                  }
                  yield* sql`DELETE FROM search_document_staging_parts
                    WHERE thread_id = ${delivery.thread.threadId} AND item_id = ${itemId}`;
                  yield* sql`DELETE FROM search_document_staging
                    WHERE thread_id = ${delivery.thread.threadId} AND item_id = ${itemId}`;
                  yield* sql`INSERT INTO search_tombstones (thread_id, item_id, revision)
                  VALUES (${delivery.thread.threadId}, ${itemId}, ${delivery.revision})
                  ON CONFLICT(thread_id, item_id) DO UPDATE SET
                    revision = MAX(search_tombstones.revision, excluded.revision)`;
                }

                const pending = yield* sql<{ readonly pending: number }>`SELECT 1 AS pending
                FROM search_document_staging WHERE thread_id = ${delivery.thread.threadId} LIMIT 1`;
                if (pending.length === 0) {
                  yield* sql`UPDATE search_threads SET complete = 1
                    WHERE thread_id = ${delivery.thread.threadId} AND complete_requested = 1`;
                }
              }
            }

            yield* recordReceipt(delivery);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isSearchIndexError(cause)
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
        readonly snapshotComplete: number | null;
        readonly hasCoverageGap: number | null;
        readonly activation: string | null;
      }>`SELECT t.thread_id AS threadId, t.revision, t.complete,
          s.complete AS snapshotComplete, s.activation, g.revision AS hasCoverageGap
        FROM search_threads t
        LEFT JOIN search_thread_snapshots s ON s.thread_id = t.thread_id
        LEFT JOIN search_thread_coverage_gaps g ON g.thread_id = t.thread_id
        WHERE t.thread_id IN (SELECT value FROM json_each(${encodeStrings(threadIds)}))
        ORDER BY t.thread_id COLLATE BINARY`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            threadId: row.threadId,
            revision: row.revision,
            complete: row.hasCoverageGap === null && (row.snapshotComplete ?? row.complete) === 1,
            ...(row.activation === null ? {} : { activation: row.activation }),
          })),
        ),
        Effect.mapError(
          (cause) => new SearchIndex.SearchIndexError({ operation: "progress", cause }),
        ),
      );
    };

    return SearchIndex.SearchIndex.of({
      generation: "1",
      disabled: false,
      deliver,
      query,
      progress,
    });
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
      isSearchIndexError(cause)
        ? cause
        : new SearchIndex.SearchIndexError({ operation: "initialize", cause }),
    ),
  );

export const advanceLegacyConversion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqliteSearchParts.advanceLegacyConversion(sql);
}).pipe(
  Effect.mapError(
    (cause) =>
      new SearchIndex.SearchIndexError({
        operation: "legacyConversion",
        cause,
      }),
  ),
);

export const layer = (home: SearchIndex.SearchHome) =>
  Layer.effect(SearchIndex.SearchIndex, make(home));
