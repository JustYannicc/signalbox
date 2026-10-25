import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SearchIndex from "../SearchIndex.ts";
import * as SqliteSearchQueries from "./SqliteSearchQueries.ts";

const MAX_PART_UNITS = 16_000;
const CONVERSION_CHUNK_CODEPOINTS = 8_000;
const SEARCH_OVERLAP_UNITS = 512;

interface TextPart {
  readonly offset: number;
  readonly text: string;
  readonly totalLength: number;
}

const splitText = (text: string): ReadonlyArray<TextPart> => {
  if (text.length === 0) return [{ offset: 0, text: "", totalLength: 0 }];
  const parts: Array<TextPart> = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + MAX_PART_UNITS);
    if (end < text.length) {
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
    }
    parts.push({ offset, text: text.slice(offset, end), totalLength: text.length });
    offset = end;
  }
  return parts;
};

const tail = (text: string, length: number) => {
  let start = Math.max(0, text.length - length);
  if (start > 0) {
    const first = text.charCodeAt(start);
    const previous = text.charCodeAt(start - 1);
    if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
  }
  return text.slice(start);
};

const head = (text: string, length: number) => {
  let end = Math.min(text.length, length);
  if (end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return text.slice(0, end);
};

const searchWindows = (parts: ReadonlyArray<{ readonly offset: number; readonly text: string }>) =>
  parts.map((part, index) => {
    let left = "";
    for (let cursor = index - 1; cursor >= 0 && left.length < SEARCH_OVERLAP_UNITS; cursor -= 1) {
      left = tail(parts[cursor]!.text, SEARCH_OVERLAP_UNITS - left.length) + left;
    }
    let right = "";
    for (
      let cursor = index + 1;
      cursor < parts.length && right.length < SEARCH_OVERLAP_UNITS;
      cursor += 1
    ) {
      right += head(parts[cursor]!.text, SEARCH_OVERLAP_UNITS - right.length);
    }
    return { ...part, window: left + part.text + right };
  });

export const splitDocument = (document: SearchIndex.SearchDocument) =>
  splitText(document.text).map((part) => ({ ...document, ...part }));

export const boundPart = (part: SearchIndex.SearchDocumentPart) =>
  splitText(part.text).map((piece) => ({
    ...part,
    offset: part.offset + piece.offset,
    text: piece.text,
  }));

export const deleteIndexedParts = (sql: SqlClient.SqlClient, documentId: number) =>
  Effect.gen(function* () {
    const indexed = yield* sql<{ readonly id: number }>`SELECT id FROM search_document_parts
    WHERE document_id = ${documentId}`;
    for (const part of indexed) {
      yield* sql`DELETE FROM search_document_parts_fts WHERE rowid = ${part.id}`;
    }
    yield* sql`DELETE FROM search_document_parts WHERE document_id = ${documentId}`;
  });

export const stagePart = (
  sql: SqlClient.SqlClient,
  part: SearchIndex.SearchDocumentPart,
  revision: number,
  sourceSequence: number,
) =>
  Effect.gen(function* () {
    const tombstones = yield* sql<{ readonly revision: number }>`SELECT revision
    FROM search_tombstones WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId}`;
    if (tombstones[0] !== undefined && tombstones[0].revision >= revision) return;
    if (tombstones[0] !== undefined) {
      yield* sql`DELETE FROM search_tombstones
      WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId}
        AND revision < ${revision}`;
    }

    const published = yield* sql<{
      readonly id: number;
      readonly revision: number;
    }>`SELECT id, revision
    FROM search_documents WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId}`;
    if (published[0] !== undefined && published[0].revision >= revision) return;

    yield* sql`DELETE FROM search_document_staging_parts
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId}
      AND revision < ${revision}`;
    yield* sql`DELETE FROM search_document_staging
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision < ${revision}`;

    const malformed =
      part.offset + part.text.length > part.totalLength ||
      (part.text.length === 0 && part.totalLength > 0);
    const staged = yield* sql<{
      readonly source_sequence: number | null;
      readonly entry_id: string;
      readonly run_id: string | null;
      readonly position: number;
      readonly kind: string;
      readonly created_at: string | null;
      readonly total_length: number;
      readonly invalid: number;
    }>`SELECT source_sequence, entry_id, run_id, position, kind, created_at, total_length, invalid
    FROM search_document_staging
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
    const old = staged[0];
    if (old === undefined) {
      yield* sql`INSERT INTO search_document_staging
      (thread_id, item_id, revision, source_sequence, entry_id, run_id, position, kind, created_at, total_length, invalid)
      VALUES (${part.threadId}, ${part.itemId}, ${revision}, ${sourceSequence}, ${part.entryId}, ${part.runId},
        ${part.position}, ${part.kind}, ${part.createdAt}, ${part.totalLength}, ${malformed ? 1 : 0})`;
    } else {
      const conflict =
        (old.source_sequence !== null && old.source_sequence !== sourceSequence) ||
        old.entry_id !== part.entryId ||
        old.run_id !== part.runId ||
        old.position !== part.position ||
        old.kind !== part.kind ||
        old.created_at !== part.createdAt ||
        old.total_length !== part.totalLength ||
        malformed;
      if (conflict) {
        yield* sql`UPDATE search_document_staging SET invalid = 1
        WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
      }
    }

    const [state] = yield* sql<{
      readonly invalid: number;
    }>`SELECT invalid FROM search_document_staging
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
    if (state === undefined || state.invalid === 1) return;

    const existing = yield* sql<{
      readonly text: string;
    }>`SELECT text FROM search_document_staging_parts
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId}
      AND revision = ${revision} AND offset = ${part.offset}`;
    if (existing[0] !== undefined) {
      if (existing[0].text !== part.text) {
        yield* sql`UPDATE search_document_staging SET invalid = 1
        WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
        return;
      }
    } else {
      const existingParts = yield* sql<{
        readonly offset: number;
        readonly text: string;
      }>`SELECT offset, text
      FROM search_document_staging_parts
      WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
      const overlaps = existingParts.some(
        (value) =>
          value.offset < part.offset + part.text.length &&
          part.offset < value.offset + value.text.length,
      );
      if (overlaps) {
        yield* sql`UPDATE search_document_staging SET invalid = 1
        WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
        return;
      }
      yield* sql`INSERT INTO search_document_staging_parts
      (thread_id, item_id, revision, offset, text)
      VALUES (${part.threadId}, ${part.itemId}, ${revision}, ${part.offset}, ${part.text})`;
    }

    const stagedParts = yield* sql<{ readonly offset: number; readonly text: string }>`
    SELECT offset, text FROM search_document_staging_parts
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}
    ORDER BY offset`;
    let cursor = 0;
    for (const value of stagedParts) {
      if (value.offset !== cursor) return;
      cursor += value.text.length;
    }
    if (cursor !== part.totalLength) return;

    const previousId = published[0]?.id;
    if (previousId !== undefined) {
      yield* sql`DELETE FROM search_documents_fts WHERE rowid = ${previousId}`;
      yield* deleteIndexedParts(sql, previousId);
      yield* sql`DELETE FROM search_document_conversion WHERE document_id = ${previousId}`;
    }
    const [stagedMetadata] = yield* sql<{
      readonly source_sequence: number | null;
    }>`SELECT source_sequence
    FROM search_document_staging
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
    if (stagedMetadata === undefined) return;
    yield* sql`INSERT INTO search_documents
    (thread_id, item_id, entry_id, run_id, position, kind, text, search_text,
      literal_text, created_at, revision, source_sequence)
    VALUES (${part.threadId}, ${part.itemId}, ${part.entryId}, ${part.runId},
      ${part.position}, ${part.kind}, '', '', '', ${part.createdAt}, ${revision}, ${stagedMetadata.source_sequence ?? 0})
    ON CONFLICT(thread_id, item_id) DO UPDATE SET
      entry_id = excluded.entry_id, run_id = excluded.run_id, position = excluded.position,
      kind = excluded.kind, text = '', search_text = '', literal_text = '',
      created_at = excluded.created_at, revision = excluded.revision,
      source_sequence = excluded.source_sequence
    WHERE excluded.revision > search_documents.revision`;
    const documents = yield* sql<{ readonly id: number }>`SELECT id FROM search_documents
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId}`;
    const documentId = documents[0]?.id;
    if (documentId === undefined) return;

    const windows = searchWindows(
      stagedParts.map((value) => ({
        ...value,
        totalLength: part.totalLength,
      })),
    );
    for (let partIndex = 0; partIndex < windows.length; partIndex += 1) {
      const value = windows[partIndex]!;
      const indexed = yield* sql<{ readonly id: number }>`INSERT INTO search_document_parts
      (document_id, part_index, offset, total_length, unit_length, text, search_text, literal_text)
      VALUES (${documentId}, ${partIndex}, ${value.offset}, ${part.totalLength}, ${value.text.length}, ${value.text},
        ${SqliteSearchQueries.normalizeKeywordText(value.window)},
        ${SqliteSearchQueries.foldLiteralText(value.window)})
      RETURNING id`;
      const partId = indexed[0]?.id;
      if (partId !== undefined && value.window.length > 0) {
        yield* sql`INSERT INTO search_document_parts_fts (rowid, search_text)
        VALUES (${partId}, ${SqliteSearchQueries.normalizeKeywordText(value.window)})`;
      }
    }
    yield* sql`DELETE FROM search_document_staging_parts
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
    yield* sql`DELETE FROM search_document_staging
    WHERE thread_id = ${part.threadId} AND item_id = ${part.itemId} AND revision = ${revision}`;
  });

interface ConversionRow {
  readonly document_id: number;
  readonly char_offset: number;
  readonly unit_offset: number;
  readonly total_chars: number;
  readonly total_length: number;
  readonly stage: "reading" | "indexing" | "verifying" | "invalid";
  readonly next_part_index: number;
  readonly next_index_part: number;
}

const readConversionPart = (sql: SqlClient.SqlClient, row: ConversionRow) =>
  Effect.gen(function* () {
    const chunks = yield* sql<{
      readonly chunk: string;
    }>`SELECT substr(text, ${row.char_offset + 1},
      ${CONVERSION_CHUNK_CODEPOINTS}) AS chunk
    FROM search_documents WHERE id = ${row.document_id}`;
    const chunk = chunks[0]?.chunk ?? "";
    if (chunk.length === 0) {
      yield* sql`UPDATE search_document_conversion SET stage = 'invalid'
      WHERE document_id = ${row.document_id}`;
      yield* Effect.logWarning("legacy search document conversion stopped: source chunk missing", {
        documentId: row.document_id,
      });
      return true;
    }
    const codepoints = Array.from(chunk).length;
    yield* sql`INSERT INTO search_document_parts
    (document_id, part_index, offset, total_length, unit_length, text, search_text, literal_text)
    VALUES (${row.document_id}, ${row.next_part_index}, ${row.unit_offset}, 0, ${chunk.length}, ${chunk}, '', '')`;
    const nextChar = row.char_offset + codepoints;
    const nextUnits = row.unit_offset + chunk.length;
    if (nextChar >= row.total_chars) {
      yield* sql`UPDATE search_document_parts SET total_length = ${nextUnits}
      WHERE document_id = ${row.document_id}`;
      yield* sql`UPDATE search_document_conversion SET char_offset = ${nextChar},
      unit_offset = ${nextUnits}, total_length = ${nextUnits},
      next_part_index = ${row.next_part_index + 1}, stage = 'indexing', next_index_part = 0
      WHERE document_id = ${row.document_id}`;
    } else {
      yield* sql`UPDATE search_document_conversion SET char_offset = ${nextChar},
      unit_offset = ${nextUnits}, next_part_index = ${row.next_part_index + 1}
      WHERE document_id = ${row.document_id}`;
    }
    return true;
  });

const indexConversionPart = (sql: SqlClient.SqlClient, row: ConversionRow) =>
  Effect.gen(function* () {
    const currentRows = yield* sql<{
      readonly id: number;
      readonly part_index: number;
      readonly offset: number;
      readonly text: string;
    }>`SELECT id, part_index, offset, text FROM search_document_parts
    WHERE document_id = ${row.document_id} AND part_index = ${row.next_index_part}`;
    const current = currentRows[0];
    if (current === undefined) {
      yield* sql`UPDATE search_document_conversion SET stage = 'invalid'
      WHERE document_id = ${row.document_id}`;
      yield* Effect.logWarning("legacy search document conversion stopped: indexed part missing", {
        documentId: row.document_id,
      });
      return true;
    }
    const neighbours = yield* sql<{ readonly part_index: number; readonly text: string }>`
    SELECT part_index, text FROM search_document_parts
    WHERE document_id = ${row.document_id}
      AND part_index BETWEEN ${current.part_index - 1} AND ${current.part_index + 1}
    ORDER BY part_index`;
    const index = neighbours.findIndex((part) => part.part_index === current.part_index);
    const window = [
      index > 0 ? tail(neighbours[index - 1]!.text, SEARCH_OVERLAP_UNITS) : "",
      current.text,
      index + 1 < neighbours.length ? head(neighbours[index + 1]!.text, SEARCH_OVERLAP_UNITS) : "",
    ].join("");
    const normalized = SqliteSearchQueries.normalizeKeywordText(window);
    yield* sql`UPDATE search_document_parts SET search_text = ${normalized},
    literal_text = ${SqliteSearchQueries.foldLiteralText(window)} WHERE id = ${current.id}`;
    yield* sql`INSERT INTO search_document_parts_fts (rowid, search_text)
    VALUES (${current.id}, ${normalized})`;

    const nextPart = row.next_index_part + 1;
    if (nextPart >= row.next_part_index) {
      yield* sql`UPDATE search_document_conversion SET stage = 'verifying'
      WHERE document_id = ${row.document_id}`;
      return true;
    }
    yield* sql`UPDATE search_document_conversion SET next_index_part = ${nextPart}
    WHERE document_id = ${row.document_id}`;
    return true;
  });

const hasConversionWork = (sql: SqlClient.SqlClient) =>
  sql<{ readonly pending: number }>`SELECT 1 AS pending
  FROM search_document_conversion
  WHERE stage IN ('reading', 'indexing', 'verifying')
  UNION ALL
  SELECT 1 AS pending FROM search_documents d
  WHERE d.text <> '' AND NOT EXISTS (
    SELECT 1 FROM search_document_conversion c WHERE c.document_id = d.id)
  LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

/** Advances at most one bounded chunk or part-index write and keeps old data until final commit. */
export const advanceLegacyConversion = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      let [row] = yield* sql<ConversionRow>`SELECT document_id, char_offset, unit_offset,
        total_chars, total_length, stage, next_part_index, next_index_part
      FROM search_document_conversion WHERE stage IN ('reading', 'indexing', 'verifying')
      ORDER BY document_id LIMIT 1`;
      if (row === undefined) {
        const [legacy] = yield* sql<{ readonly document_id: number; readonly total_chars: number }>`
        SELECT d.id AS document_id, length(d.text) AS total_chars FROM search_documents d
        WHERE d.text <> '' AND NOT EXISTS (
          SELECT 1 FROM search_document_conversion c WHERE c.document_id = d.id)
        ORDER BY d.id LIMIT 1`;
        if (legacy === undefined) return false;
        yield* sql`INSERT INTO search_document_conversion
        (document_id, char_offset, unit_offset, total_chars, total_length, stage,
          next_part_index, next_index_part)
        VALUES (${legacy.document_id}, 0, 0, ${legacy.total_chars}, 0, 'reading', 0, 0)`;
        [row] = yield* sql<ConversionRow>`SELECT document_id, char_offset, unit_offset,
          total_chars, total_length, stage, next_part_index, next_index_part
        FROM search_document_conversion WHERE document_id = ${legacy.document_id}`;
      }
      if (row === undefined) return false;

      if (row.stage === "reading") {
        yield* readConversionPart(sql, row);
      } else if (row.stage === "indexing") {
        yield* indexConversionPart(sql, row);
      } else {
        const [document] = yield* sql<{
          readonly original_bytes: number;
          readonly part_bytes: number | null;
          readonly part_count: number;
          readonly first_part: number | null;
          readonly last_part: number | null;
          readonly total_min: number | null;
          readonly total_max: number | null;
          readonly first_offset: number | null;
          readonly last_end: number | null;
          readonly units: number | null;
        }>`SELECT length(CAST(d.text AS BLOB)) AS original_bytes,
          SUM(length(CAST(p.text AS BLOB))) AS part_bytes, COUNT(p.id) AS part_count,
          MIN(p.part_index) AS first_part, MAX(p.part_index) AS last_part,
          MIN(p.total_length) AS total_min, MAX(p.total_length) AS total_max,
          MIN(p.offset) AS first_offset, MAX(p.offset + p.unit_length) AS last_end,
          SUM(p.unit_length) AS units
        FROM search_documents d LEFT JOIN search_document_parts p ON p.document_id = d.id
        WHERE d.id = ${row.document_id}
        GROUP BY d.id`;
        const [gaps] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM (
        SELECT offset, LAG(offset + unit_length) OVER (ORDER BY part_index) AS previous_end
        FROM search_document_parts WHERE document_id = ${row.document_id}
      ) WHERE previous_end IS NOT NULL AND offset != previous_end`;
        const [missingFts] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM search_document_parts p WHERE p.document_id = ${row.document_id}
          AND p.text <> '' AND NOT EXISTS (
            SELECT 1 FROM search_document_parts_fts f
            WHERE f.rowid = p.id AND f.search_text = p.search_text)`;
        const complete =
          document !== undefined &&
          document.original_bytes === document.part_bytes &&
          document.part_count > 0 &&
          document.first_part === 0 &&
          document.last_part === document.part_count - 1 &&
          document.total_min === row.total_length &&
          document.total_max === row.total_length &&
          document.first_offset === 0 &&
          document.last_end === row.total_length &&
          document.units === row.total_length &&
          gaps?.count === 0 &&
          missingFts?.count === 0;
        if (complete) {
          yield* sql`DELETE FROM search_documents_fts WHERE rowid = ${row.document_id}`;
          yield* sql`UPDATE search_documents SET text = '', search_text = '', literal_text = ''
          WHERE id = ${row.document_id}`;
          yield* sql`DELETE FROM search_document_conversion WHERE document_id = ${row.document_id}`;
        } else {
          yield* sql`UPDATE search_document_conversion SET stage = 'invalid'
          WHERE document_id = ${row.document_id}`;
          yield* Effect.logWarning(
            "legacy search document conversion verification failed; row retained",
            {
              documentId: row.document_id,
            },
          );
        }
      }
      return yield* hasConversionWork(sql);
    }),
  );
