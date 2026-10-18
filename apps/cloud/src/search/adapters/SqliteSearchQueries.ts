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
const keywordTerms = (query: string) => [
  ...new Set(normalizeKeywordText(query).match(/[\p{L}\p{N}_]+/gu) ?? []),
];

const keywordExpression = (term: string) => `"${term.replaceAll('"', '""')}"`;

const matchRank = (sql: SqlClient.SqlClient, order: QueryInput["order"]) =>
  order === "legacy"
    ? sql`CASE d.kind WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 99 END`
    : sql`CASE d.kind
        WHEN 'thread' THEN 0 WHEN 'user' THEN 1 WHEN 'assistant' THEN 2
        WHEN 'summary' THEN 3 WHEN 'tool' THEN 4 WHEN 'approval' THEN 5
        WHEN 'state' THEN 6 ELSE 99 END`;

const afterPredicate = (sql: SqlClient.SqlClient, after: QueryInput["after"]) =>
  after === null
    ? sql.literal("1 = 1")
    : sql`(matchRank > ${after.matchRank}
        OR (matchRank = ${after.matchRank} AND threadUpdatedAt < ${after.threadUpdatedAt})
        OR (matchRank = ${after.matchRank} AND threadUpdatedAt = ${after.threadUpdatedAt}
          AND threadId COLLATE BINARY > ${after.threadId})
        OR (matchRank = ${after.matchRank} AND threadUpdatedAt = ${after.threadUpdatedAt}
          AND threadId = ${after.threadId} AND itemId COLLATE BINARY > ${after.itemId}))`;

const ordering = (sql: SqlClient.SqlClient) => sql`
  matchRank ASC, threadUpdatedAt DESC, threadId COLLATE BINARY ASC, itemId COLLATE BINARY ASC`;

const contentMatch = (
  sql: SqlClient.SqlClient,
  input: QueryInput,
  terms: ReadonlyArray<string>,
) => {
  if (input.mode === "literal") {
    return {
      predicate: sql`instr(d.literal_text, ${foldLiteralText(input.query)}) > 0 OR EXISTS (
        SELECT 1 FROM search_document_parts p WHERE p.document_id = d.id
          AND instr(p.literal_text, ${foldLiteralText(input.query)}) > 0)`,
    };
  }

  // workerd caps compound SELECTs at five. Join the terms instead of adding two per word.
  const expressions = encodeStrings(terms.map(keywordExpression));
  return {
    predicate: sql`d.id IN (SELECT documentId FROM (
      SELECT f.rowid AS documentId, term.key AS termIndex
      FROM json_each(${expressions}) term
      CROSS JOIN search_documents_fts f
      WHERE search_documents_fts MATCH term.value
      UNION ALL
      SELECT p.document_id AS documentId, term.key AS termIndex
      FROM json_each(${expressions}) term
      CROSS JOIN search_document_parts_fts f
      JOIN search_document_parts p ON p.id = f.rowid
      WHERE search_document_parts_fts MATCH term.value
    ) km
      GROUP BY documentId HAVING COUNT(DISTINCT km.termIndex) = ${terms.length})`,
  };
};

/** Scope and content filters are applied before paging; dedupe selects each thread's best tuple. */
export const query = (sql: SqlClient.SqlClient, input: QueryInput) => {
  if (input.threadIds.length === 0 || input.query.length === 0) {
    return Effect.succeed({ candidates: [], hasMore: false });
  }
  const terms = input.mode === "keyword" ? keywordTerms(input.query) : [];
  if (input.mode === "keyword" && terms.length === 0) {
    return Effect.succeed({ candidates: [], hasMore: false });
  }
  const content = contentMatch(sql, input, terms);
  const kindFilter =
    input.kinds === undefined || input.kinds.length === 0
      ? sql.literal("1 = 1")
      : sql`d.kind IN (SELECT value FROM json_each(${encodeStrings(input.kinds)}))`;
  const matching = sql`
    SELECT d.thread_id AS threadId, d.item_id AS itemId, d.entry_id AS entryId,
      d.run_id AS runId, d.position AS position, d.kind AS kind,
      d.created_at AS createdAt, t.title AS title, t.archived AS archived,
      d.revision AS revision, d.source_sequence AS sourceSequence,
      t.updated_at AS threadUpdatedAt, ${matchRank(sql, input.order)} AS matchRank
    FROM search_documents d
    JOIN search_threads t ON t.thread_id = d.thread_id
    WHERE (${content.predicate})
      AND d.thread_id IN (SELECT value FROM json_each(${encodeStrings(input.threadIds)}))
      AND t.deleted = 0
      AND ${kindFilter}
    `;
  const rows = input.distinctThreads
    ? sql<CandidateRow>`WITH matching AS (${matching}), ranked AS (
        SELECT matching.*, ROW_NUMBER() OVER (
          PARTITION BY threadId ORDER BY ${ordering(sql)}
        ) AS threadRank
        FROM matching
      )
      SELECT threadId, itemId, entryId, runId, position, kind, createdAt,
        title, archived, revision, sourceSequence, threadUpdatedAt, matchRank
      FROM ranked
      WHERE threadRank = 1 AND (${afterPredicate(sql, input.after)})
      ORDER BY ${ordering(sql)}
      LIMIT ${Math.max(0, Math.floor(input.limit)) + 1}`
    : sql<CandidateRow>`WITH matching AS (${matching})
      SELECT threadId, itemId, entryId, runId, position, kind, createdAt,
        title, archived, revision, sourceSequence, threadUpdatedAt, matchRank
      FROM matching
      WHERE ${afterPredicate(sql, input.after)}
      ORDER BY ${ordering(sql)}
      LIMIT ${Math.max(0, Math.floor(input.limit)) + 1}`;

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
