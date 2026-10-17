import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SearchIndex from "../SearchIndex.ts";

const StringsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStrings = Schema.encodeSync(StringsJson);
type QueryInput = Parameters<SearchIndex.SearchIndex["Service"]["query"]>[0];
type CandidateRow = Omit<SearchIndex.SearchCandidate, "archived"> & { readonly archived: number };

/** Keyword matching follows searchText.ts, which the service uses to verify FTS candidates. */
export const normalizeKeywordText = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");

/** Matches threadSearch.ts exactly, including its Unicode length-expansion behavior. */
export const foldLiteralText = (text: string) => {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;
  let folded = "";
  for (const character of text) {
    const lowerCharacter = character.toLowerCase().replace(/ς/g, "σ");
    folded += lowerCharacter.length === character.length ? lowerCharacter : character;
  }
  return folded;
};

/** FTS5 operators are never accepted from the caller; parsed search terms are quoted. */
const keywordExpression = (query: string) => {
  const terms = normalizeKeywordText(query).match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.length === 0
    ? null
    : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
};

const keywordSql = (
  sql: SqlClient.SqlClient,
  input: QueryInput,
  keyword: string,
  distinctThreads: boolean,
  kinds: ReadonlyArray<string>,
) =>
  distinctThreads
    ? sql<CandidateRow>`WITH matching AS (
      SELECT d.thread_id AS threadId, d.item_id AS itemId, d.entry_id AS entryId,
        d.run_id AS runId, d.position AS position, d.kind AS kind, d.text AS text,
        d.created_at AS createdAt, t.title AS title, t.archived AS archived,
        t.revision AS revision, t.source_sequence AS sourceSequence
      FROM search_documents_fts
      JOIN search_documents d ON d.id = search_documents_fts.rowid
      JOIN search_threads t ON t.thread_id = d.thread_id
      WHERE search_documents_fts MATCH ${keyword}
        AND d.thread_id IN (SELECT value FROM json_each(${encodeStrings(input.threadIds)}))
        AND t.deleted = 0
        AND (${kinds.length === 0 ? 1 : 0} = 1 OR d.kind IN
          (SELECT value FROM json_each(${encodeStrings(kinds)})))
    ), ranked AS (
      SELECT matching.*, ROW_NUMBER() OVER (
        PARTITION BY threadId ORDER BY itemId COLLATE BINARY
      ) AS threadRank FROM matching
    )
    SELECT threadId, itemId, entryId, runId, position, kind, text, createdAt,
      title, archived, revision, sourceSequence
    FROM ranked
    WHERE threadRank = 1
      AND (${input.after === null ? 1 : 0} = 1 OR threadId > ${input.after?.threadId ?? ""}
        OR (threadId = ${input.after?.threadId ?? ""} AND itemId > ${input.after?.itemId ?? ""}))
    ORDER BY threadId COLLATE BINARY, itemId COLLATE BINARY
    LIMIT ${Math.max(0, Math.floor(input.limit)) + 1}`
    : sql<CandidateRow>`SELECT
      d.thread_id AS threadId, d.item_id AS itemId, d.entry_id AS entryId,
      d.run_id AS runId, d.position AS position, d.kind AS kind, d.text AS text,
      d.created_at AS createdAt, t.title AS title, t.archived AS archived,
      t.revision AS revision, t.source_sequence AS sourceSequence
    FROM search_documents_fts
    JOIN search_documents d ON d.id = search_documents_fts.rowid
    JOIN search_threads t ON t.thread_id = d.thread_id
    WHERE search_documents_fts MATCH ${keyword}
      AND d.thread_id IN (SELECT value FROM json_each(${encodeStrings(input.threadIds)}))
      AND t.deleted = 0
      AND (${kinds.length === 0 ? 1 : 0} = 1 OR d.kind IN
        (SELECT value FROM json_each(${encodeStrings(kinds)})))
      AND (${input.after === null ? 1 : 0} = 1 OR d.thread_id > ${input.after?.threadId ?? ""}
        OR (d.thread_id = ${input.after?.threadId ?? ""} AND d.item_id > ${input.after?.itemId ?? ""}))
    ORDER BY d.thread_id COLLATE BINARY, d.item_id COLLATE BINARY
    LIMIT ${Math.max(0, Math.floor(input.limit)) + 1}`;

const literalSql = (
  sql: SqlClient.SqlClient,
  input: QueryInput,
  distinctThreads: boolean,
  kinds: ReadonlyArray<string>,
) =>
  distinctThreads
    ? sql<CandidateRow>`WITH matching AS (
      SELECT d.thread_id AS threadId, d.item_id AS itemId, d.entry_id AS entryId,
        d.run_id AS runId, d.position AS position, d.kind AS kind, d.text AS text,
        d.created_at AS createdAt, t.title AS title, t.archived AS archived,
        t.revision AS revision, t.source_sequence AS sourceSequence
      FROM search_documents d
      JOIN search_threads t ON t.thread_id = d.thread_id
      WHERE instr(d.literal_text, ${foldLiteralText(input.query)}) > 0
        AND d.thread_id IN (SELECT value FROM json_each(${encodeStrings(input.threadIds)}))
        AND t.deleted = 0
        AND (${kinds.length === 0 ? 1 : 0} = 1 OR d.kind IN
          (SELECT value FROM json_each(${encodeStrings(kinds)})))
    ), ranked AS (
      SELECT matching.*, ROW_NUMBER() OVER (
        PARTITION BY threadId ORDER BY itemId COLLATE BINARY
      ) AS threadRank FROM matching
    )
    SELECT threadId, itemId, entryId, runId, position, kind, text, createdAt,
      title, archived, revision, sourceSequence
    FROM ranked
    WHERE threadRank = 1
      AND (${input.after === null ? 1 : 0} = 1 OR threadId > ${input.after?.threadId ?? ""}
        OR (threadId = ${input.after?.threadId ?? ""} AND itemId > ${input.after?.itemId ?? ""}))
    ORDER BY threadId COLLATE BINARY, itemId COLLATE BINARY
    LIMIT ${Math.max(0, Math.floor(input.limit)) + 1}`
    : sql<CandidateRow>`SELECT
      d.thread_id AS threadId, d.item_id AS itemId, d.entry_id AS entryId,
      d.run_id AS runId, d.position AS position, d.kind AS kind, d.text AS text,
      d.created_at AS createdAt, t.title AS title, t.archived AS archived,
      t.revision AS revision, t.source_sequence AS sourceSequence
    FROM search_documents d
    JOIN search_threads t ON t.thread_id = d.thread_id
    WHERE instr(d.literal_text, ${foldLiteralText(input.query)}) > 0
      AND d.thread_id IN (SELECT value FROM json_each(${encodeStrings(input.threadIds)}))
      AND t.deleted = 0
      AND (${kinds.length === 0 ? 1 : 0} = 1 OR d.kind IN
        (SELECT value FROM json_each(${encodeStrings(kinds)})))
      AND (${input.after === null ? 1 : 0} = 1 OR d.thread_id > ${input.after?.threadId ?? ""}
        OR (d.thread_id = ${input.after?.threadId ?? ""} AND d.item_id > ${input.after?.itemId ?? ""}))
    ORDER BY d.thread_id COLLATE BINARY, d.item_id COLLATE BINARY
    LIMIT ${Math.max(0, Math.floor(input.limit)) + 1}`;

/** Scope and content filters are applied before the page limit; thread dedupe happens before cursors. */
export const query = (sql: SqlClient.SqlClient, input: QueryInput) => {
  if (input.threadIds.length === 0 || input.query.length === 0) {
    return Effect.succeed({ candidates: [], hasMore: false });
  }
  const kinds = input.kinds ?? [];
  const keyword = input.mode === "keyword" ? keywordExpression(input.query) : null;
  if (input.mode === "keyword" && keyword === null) {
    return Effect.succeed({ candidates: [], hasMore: false });
  }
  const rows =
    input.mode === "keyword"
      ? keywordSql(sql, input, keyword!, input.distinctThreads ?? false, kinds)
      : literalSql(sql, input, input.distinctThreads ?? false, kinds);
  return rows.pipe(
    Effect.map((found) => ({
      candidates: found.slice(0, Math.max(0, Math.floor(input.limit))).map((row) => ({
        ...row,
        archived: row.archived === 1,
      })),
      hasMore: found.length > Math.max(0, Math.floor(input.limit)),
    })),
  );
};
