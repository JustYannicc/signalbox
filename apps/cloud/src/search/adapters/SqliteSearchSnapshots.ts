import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SearchIndex from "../SearchIndex.ts";

const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
type Snapshot = NonNullable<SearchIndex.SearchDelivery["snapshot"]> & {
  readonly revision: number;
};

/** Records an uncovered source revision without replacing cached thread metadata. */
export const recordCoverageGap = (sql: SqlClient.SqlClient, delivery: SearchIndex.SearchDelivery) =>
  Effect.gen(function* () {
    const [coverage] = yield* sql<{
      readonly coveredRevision: number;
    }>`SELECT covered_revision AS coveredRevision FROM search_thread_snapshots
      WHERE thread_id = ${delivery.thread.threadId}`;
    if (delivery.revision <= (coverage?.coveredRevision ?? 0)) return;

    yield* sql`INSERT INTO search_threads
      (thread_id, title, archived, deleted, revision, source_sequence, complete,
        updated_at, complete_requested)
      VALUES (${delivery.thread.threadId}, '', ${delivery.thread.archived ? 1 : 0},
        ${delivery.thread.deleted ? 1 : 0}, ${delivery.revision}, ${delivery.sourceSequence},
        0, '', 0)
      ON CONFLICT(thread_id) DO UPDATE SET
        revision = MAX(search_threads.revision, excluded.revision),
        source_sequence = MAX(search_threads.source_sequence, excluded.source_sequence)`;
    yield* sql`INSERT INTO search_thread_coverage_gaps (thread_id, revision)
      VALUES (${delivery.thread.threadId}, ${delivery.revision})
      ON CONFLICT(thread_id) DO UPDATE SET
        revision = MAX(search_thread_coverage_gaps.revision, excluded.revision)`;
  });

/** Starts a newer source snapshot and fences pages from older activations. */
export const acceptActivation = (sql: SqlClient.SqlClient, threadId: string, snapshot: Snapshot) =>
  Effect.gen(function* () {
    const [current] = yield* sql<{
      readonly activation: string;
      readonly revision: number;
      readonly complete: number;
    }>`SELECT activation, revision, complete
      FROM search_thread_snapshots WHERE thread_id = ${threadId}`;
    if (current !== undefined && snapshot.revision < current.revision) return false;
    if (
      current !== undefined &&
      snapshot.revision === current.revision &&
      snapshot.activation !== current.activation
    )
      return false;
    if (current?.activation === snapshot.activation && current.revision === snapshot.revision) {
      return current.complete !== 1;
    }

    yield* sql`DELETE FROM search_snapshot_pages WHERE thread_id = ${threadId}`;
    yield* sql`DELETE FROM search_snapshot_items WHERE thread_id = ${threadId}`;
    yield* sql`INSERT INTO search_thread_snapshots
      (thread_id, activation, revision, final_page, complete)
      VALUES (${threadId}, ${snapshot.activation}, ${snapshot.revision}, NULL, 0)
      ON CONFLICT(thread_id) DO UPDATE SET
        activation = excluded.activation, revision = excluded.revision,
        final_page = NULL, complete = 0`;
    return true;
  });

/** Snapshot membership is recorded before item publication so split parts stay one logical item. */
export const recordItems = (
  sql: SqlClient.SqlClient,
  threadId: string,
  snapshot: Snapshot,
  itemIds: ReadonlyArray<string>,
) => {
  if (itemIds.length === 0) return Effect.void;
  return sql`INSERT OR IGNORE INTO search_snapshot_items
    (thread_id, activation, revision, item_id)
    SELECT ${threadId}, ${snapshot.activation}, ${snapshot.revision}, value
    FROM json_each(${encodeStrings(itemIds)})`;
};

/** Commits a full snapshot only after every page and staged document has landed. */
export const commitIfCovered = (sql: SqlClient.SqlClient, threadId: string, snapshot: Snapshot) =>
  Effect.gen(function* () {
    const [state] = yield* sql<{
      readonly final_page: number | null;
      readonly complete: number;
    }>`SELECT final_page, complete FROM search_thread_snapshots
      WHERE thread_id = ${threadId} AND activation = ${snapshot.activation}
        AND revision = ${snapshot.revision}`;
    if (state === undefined || state.complete === 1) return false;

    yield* sql`INSERT INTO search_snapshot_pages
      (thread_id, activation, revision, page, final)
      VALUES (${threadId}, ${snapshot.activation}, ${snapshot.revision}, ${snapshot.page}, ${snapshot.final ? 1 : 0})
      ON CONFLICT(thread_id, activation, revision, page) DO UPDATE SET
        final = MAX(search_snapshot_pages.final, excluded.final)`;
    if (snapshot.final) {
      yield* sql`UPDATE search_thread_snapshots SET final_page = COALESCE(final_page, ${snapshot.page})
        WHERE thread_id = ${threadId} AND activation = ${snapshot.activation}
          AND revision = ${snapshot.revision}
          AND (final_page IS NULL OR final_page = ${snapshot.page})`;
    }

    const [current] = yield* sql<{
      readonly final_page: number | null;
      readonly complete: number;
    }>`SELECT final_page, complete FROM search_thread_snapshots
      WHERE thread_id = ${threadId} AND activation = ${snapshot.activation}
        AND revision = ${snapshot.revision}`;
    if (current?.complete === 1 || current?.final_page === null || current === undefined)
      return false;

    const [pages] = yield* sql<{
      readonly count: number;
      readonly first: number | null;
      readonly last: number | null;
      readonly finals: number;
    }>`SELECT COUNT(*) AS count, MIN(page) AS first, MAX(page) AS last, SUM(final) AS finals
      FROM search_snapshot_pages
      WHERE thread_id = ${threadId} AND activation = ${snapshot.activation}
        AND revision = ${snapshot.revision}`;
    const finalPage = current.final_page;
    if (
      pages === undefined ||
      pages.count !== finalPage + 1 ||
      pages.first !== 0 ||
      pages.last !== finalPage ||
      pages.finals !== 1
    )
      return false;

    const pending = yield* sql<{ readonly pending: number }>`SELECT 1 AS pending
      FROM search_snapshot_items i
      JOIN search_document_staging s
        ON s.thread_id = i.thread_id AND s.item_id = i.item_id
      WHERE i.thread_id = ${threadId} AND i.activation = ${snapshot.activation}
        AND i.revision = ${snapshot.revision} AND s.revision <= ${snapshot.revision} LIMIT 1`;
    if (pending.length > 0) return false;

    const absent = sql`d.thread_id = ${threadId} AND d.revision <= ${snapshot.revision}
      AND NOT EXISTS (SELECT 1 FROM search_snapshot_items i
        WHERE i.thread_id = ${threadId} AND i.activation = ${snapshot.activation}
          AND i.revision = ${snapshot.revision} AND i.item_id = d.item_id)`;

    yield* sql`INSERT INTO search_tombstones (thread_id, item_id, revision)
      SELECT d.thread_id, d.item_id, ${snapshot.revision} FROM search_documents d
      WHERE ${absent}
      ON CONFLICT(thread_id, item_id) DO UPDATE SET
        revision = MAX(search_tombstones.revision, excluded.revision)`;
    yield* sql`INSERT INTO search_tombstones (thread_id, item_id, revision)
      SELECT s.thread_id, s.item_id, ${snapshot.revision} FROM search_document_staging s
      WHERE s.thread_id = ${threadId} AND s.revision <= ${snapshot.revision}
        AND NOT EXISTS (SELECT 1 FROM search_snapshot_items i
          WHERE i.thread_id = ${threadId} AND i.activation = ${snapshot.activation}
            AND i.revision = ${snapshot.revision} AND i.item_id = s.item_id)
      ON CONFLICT(thread_id, item_id) DO UPDATE SET
        revision = MAX(search_tombstones.revision, excluded.revision)`;
    yield* sql`DELETE FROM search_documents_fts WHERE rowid IN (
      SELECT d.id FROM search_documents d WHERE ${absent})`;
    yield* sql`DELETE FROM search_document_parts_fts WHERE rowid IN (
      SELECT p.id FROM search_document_parts p JOIN search_documents d ON d.id = p.document_id
      WHERE ${absent})`;
    yield* sql`DELETE FROM search_document_conversion WHERE document_id IN (
      SELECT d.id FROM search_documents d WHERE ${absent})`;
    yield* sql`DELETE FROM search_document_parts WHERE document_id IN (
      SELECT d.id FROM search_documents d WHERE ${absent})`;
    yield* sql`DELETE FROM search_document_staging_parts WHERE thread_id = ${threadId}
      AND revision <= ${snapshot.revision} AND item_id NOT IN (
        SELECT item_id FROM search_snapshot_items WHERE thread_id = ${threadId}
          AND activation = ${snapshot.activation} AND revision = ${snapshot.revision})`;
    yield* sql`DELETE FROM search_document_staging WHERE thread_id = ${threadId}
      AND revision <= ${snapshot.revision} AND item_id NOT IN (
        SELECT item_id FROM search_snapshot_items WHERE thread_id = ${threadId}
          AND activation = ${snapshot.activation} AND revision = ${snapshot.revision})`;
    yield* sql`DELETE FROM search_documents AS d WHERE ${absent}`;
    yield* sql`UPDATE search_thread_snapshots SET complete = 1,
      covered_revision = MAX(covered_revision, ${snapshot.revision})
      WHERE thread_id = ${threadId} AND activation = ${snapshot.activation}
        AND revision = ${snapshot.revision} AND final_page = ${finalPage}`;
    yield* sql`DELETE FROM search_thread_coverage_gaps
      WHERE thread_id = ${threadId} AND revision <= ${snapshot.revision}`;
    yield* sql`UPDATE search_threads SET complete = 1, complete_requested = 1
      WHERE thread_id = ${threadId}`;
    return true;
  });
