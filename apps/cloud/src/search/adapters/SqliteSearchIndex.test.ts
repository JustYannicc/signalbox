import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SearchIndex from "../SearchIndex.ts";
import * as SqliteSearchIndex from "./SqliteSearchIndex.ts";

const home = { ownerId: "owner-1", projectId: "project-1" };

const document = (
  threadId: string,
  itemId: string,
  text: string,
  kind: SearchIndex.SearchDocument["kind"] = "user",
): SearchIndex.SearchDocument => ({
  threadId,
  itemId,
  entryId: `entry-${itemId}`,
  runId: null,
  position: 1,
  kind,
  text,
  createdAt: null,
});

const delivery = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly revision: number;
  readonly sourceSequence?: number;
  readonly documents?: ReadonlyArray<SearchIndex.SearchDocument>;
  readonly parts?: ReadonlyArray<SearchIndex.SearchDocumentPart>;
  readonly title?: string;
  readonly removed?: ReadonlyArray<string>;
  readonly complete?: boolean;
  readonly updatedAt?: string;
  readonly snapshot?: NonNullable<SearchIndex.SearchDelivery["snapshot"]>;
}): SearchIndex.SearchDelivery => ({
  home,
  thread: {
    threadId: input.threadId,
    title: input.title ?? `Title ${input.threadId}`,
    archived: false,
    deleted: false,
    updatedAt: input.updatedAt ?? "2026-10-17T00:00:00.000Z",
  },
  revision: input.revision,
  sourceSequence: input.sourceSequence ?? input.revision,
  deliveryId: input.id,
  documents: input.documents ?? [],
  ...(input.parts === undefined ? {} : { parts: input.parts }),
  removed: input.removed ?? [],
  complete: input.complete ?? false,
  ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
});

const layerForTest = () =>
  SqliteSearchIndex.layer(home).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

const deliver = (value: SearchIndex.SearchDelivery) =>
  SearchIndex.SearchIndex.use((index) => index.deliver(value));

const query = (input: {
  readonly threadIds: ReadonlyArray<string>;
  readonly query: string;
  readonly mode: "keyword" | "literal";
  readonly kinds?: ReadonlyArray<SearchIndex.SearchDocument["kind"]>;
  readonly distinctThreads?: boolean;
  readonly order?: "rich" | "legacy";
  readonly after?: SearchIndex.SearchSortKey | null;
  readonly limit?: number;
}) =>
  SearchIndex.SearchIndex.use((index) =>
    index.query({
      home,
      ...input,
      after: input.after ?? null,
      limit: input.limit ?? 20,
    }),
  );

const parts = (
  value: SearchIndex.SearchDocument,
  maxUnits = 16_000,
): ReadonlyArray<SearchIndex.SearchDocumentPart> => {
  if (value.text.length === 0) return [{ ...value, offset: 0, totalLength: 0 }];
  const result: Array<SearchIndex.SearchDocumentPart> = [];
  for (let offset = 0; offset < value.text.length;) {
    let end = Math.min(value.text.length, offset + maxUnits);
    if (end < value.text.length) {
      const before = value.text.charCodeAt(end - 1);
      const after = value.text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
    }
    result.push({
      ...value,
      text: value.text.slice(offset, end),
      offset,
      totalLength: value.text.length,
    });
    offset = end;
  }
  return result;
};

describe("SQLite search index", () => {
  it.effect("applies the authorized thread scope before LIMIT", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "denied",
          threadId: "a-denied",
          revision: 1,
          documents: [document("a-denied", "item-1", "needle in denied thread")],
          complete: true,
        }),
      );
      yield* deliver(
        delivery({
          id: "allowed",
          threadId: "z-allowed",
          revision: 1,
          documents: [
            document("z-allowed", "item-1", "needle in allowed thread"),
            document("z-allowed", "item-2", "needle in another allowed item"),
          ],
          complete: true,
        }),
      );

      const result = yield* query({
        threadIds: ["z-allowed"],
        query: "needle",
        mode: "keyword",
        limit: 1,
      });
      expect(result.candidates.map((candidate) => candidate.threadId)).toEqual(["z-allowed"]);
      expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(["item-1"]);
      expect(result.hasMore).toBe(true);
      const next = yield* query({
        threadIds: ["z-allowed"],
        query: "needle",
        mode: "keyword",
        after: {
          matchRank: 1,
          threadUpdatedAt: "2026-10-17T00:00:00.000Z",
          threadId: "z-allowed",
          itemId: "item-1",
        },
        limit: 1,
      });
      expect(next.candidates.map((candidate) => candidate.itemId)).toEqual(["item-2"]);
      expect(next.hasMore).toBe(false);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("keeps literal search as Unicode-aware infix matching", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "literal",
          threadId: "thread-1",
          revision: 1,
          documents: [document("thread-1", "item-1", "A quick Café breadcrumb")],
          complete: true,
        }),
      );

      const result = yield* query({ threadIds: ["thread-1"], query: "ICK", mode: "literal" });
      expect(result.candidates.map((candidate) => candidate.itemId)).toEqual(["item-1"]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("uses the legacy Find fold for sigma and length-expanding lowercase characters", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "unicode-literal",
          threadId: "thread-1",
          revision: 1,
          documents: [
            document("thread-1", "sigma", "ΟΣ ος οσ"),
            document("thread-1", "dotted-i", "İİİ"),
          ],
        }),
      );

      const sigma = yield* query({ threadIds: ["thread-1"], query: "Σ", mode: "literal" });
      const dottedI = yield* query({ threadIds: ["thread-1"], query: "i", mode: "literal" });
      expect(sigma.candidates.map((candidate) => candidate.itemId)).toEqual(["sigma"]);
      expect(dottedI.candidates).toEqual([]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("receipts duplicate deliveries and ignores older revisions", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "revision-2",
          threadId: "thread-1",
          revision: 2,
          documents: [document("thread-1", "item-1", "current wording")],
          complete: true,
        }),
      );
      // A reused receipt cannot replace the payload that was already accepted.
      yield* deliver(
        delivery({
          id: "revision-2",
          threadId: "thread-1",
          revision: 2,
          documents: [document("thread-1", "item-1", "duplicate stale wording")],
        }),
      );
      yield* deliver(
        delivery({
          id: "revision-1",
          threadId: "thread-1",
          revision: 1,
          documents: [document("thread-1", "item-1", "old wording")],
        }),
      );

      const current = yield* query({ threadIds: ["thread-1"], query: "current", mode: "keyword" });
      const duplicate = yield* query({
        threadIds: ["thread-1"],
        query: "duplicate stale",
        mode: "literal",
      });
      const old = yield* query({ threadIds: ["thread-1"], query: "old wording", mode: "literal" });
      expect(current.candidates.map((candidate) => candidate.itemId)).toEqual(["item-1"]);
      expect(duplicate.candidates).toEqual([]);
      expect(old.candidates).toEqual([]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("deduplicates matching threads before applying the legacy page cursor", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "many-in-one-thread",
          threadId: "thread-a",
          revision: 1,
          documents: [
            document("thread-a", "item-a", "needle first match"),
            document("thread-a", "item-b", "needle second match"),
          ],
        }),
      );
      yield* deliver(
        delivery({
          id: "one-in-next-thread",
          threadId: "thread-b",
          revision: 1,
          documents: [document("thread-b", "item-a", "needle next thread")],
        }),
      );

      const first = yield* query({
        threadIds: ["thread-a", "thread-b"],
        query: "needle",
        mode: "literal",
        distinctThreads: true,
        limit: 1,
      });
      const next = yield* query({
        threadIds: ["thread-a", "thread-b"],
        query: "needle",
        mode: "literal",
        distinctThreads: true,
        after: {
          matchRank: 1,
          threadUpdatedAt: "2026-10-17T00:00:00.000Z",
          threadId: "thread-a",
          itemId: "item-a",
        },
        limit: 1,
      });
      expect(first.candidates.map((candidate) => [candidate.threadId, candidate.itemId])).toEqual([
        ["thread-a", "item-a"],
      ]);
      expect(first.hasMore).toBe(true);
      expect(next.candidates.map((candidate) => [candidate.threadId, candidate.itemId])).toEqual([
        ["thread-b", "item-a"],
      ]);
      expect(next.hasMore).toBe(false);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("ranks content classes, then thread recency and binary IDs with tuple cursors", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "title-match",
          threadId: "m-title",
          revision: 1,
          title: "needle in the title",
          updatedAt: "2020-01-01T00:00:00.000Z",
          documents: [document("m-title", "thread", "needle in the title", "thread")],
        }),
      );
      yield* deliver(
        delivery({
          id: "recent-match",
          threadId: "a-recent",
          revision: 1,
          updatedAt: "2026-10-16T00:00:00.000Z",
          documents: [
            document("a-recent", "z-user", "needle later user"),
            document("a-recent", "a-user", "needle earlier user"),
            document("a-recent", "assistant", "needle assistant", "assistant"),
          ],
        }),
      );
      yield* deliver(
        delivery({
          id: "old-match",
          threadId: "z-old",
          revision: 1,
          updatedAt: "2025-10-16T00:00:00.000Z",
          documents: [document("z-old", "user", "needle old user")],
        }),
      );

      const first = yield* query({
        threadIds: ["m-title", "a-recent", "z-old"],
        query: "needle",
        mode: "keyword",
        limit: 1,
      });
      expect(
        first.candidates.map(({ threadId, itemId, matchRank }) => [threadId, itemId, matchRank]),
      ).toEqual([["m-title", "thread", 0]]);
      expect(first.hasMore).toBe(true);

      const next = yield* query({
        threadIds: ["m-title", "a-recent", "z-old"],
        query: "needle",
        mode: "keyword",
        after: {
          matchRank: first.candidates[0]!.matchRank,
          threadUpdatedAt: first.candidates[0]!.threadUpdatedAt,
          threadId: first.candidates[0]!.threadId,
          itemId: first.candidates[0]!.itemId,
        },
        limit: 1,
      });
      expect(next.candidates.map(({ threadId, itemId }) => [threadId, itemId])).toEqual([
        ["a-recent", "a-user"],
      ]);

      const rich = yield* query({
        threadIds: ["m-title", "a-recent", "z-old"],
        query: "needle",
        mode: "keyword",
      });
      expect(rich.candidates.map(({ threadId, itemId }) => [threadId, itemId])).toEqual([
        ["m-title", "thread"],
        ["a-recent", "a-user"],
        ["a-recent", "z-user"],
        ["z-old", "user"],
        ["a-recent", "assistant"],
      ]);

      const legacy = yield* query({
        threadIds: ["m-title", "a-recent", "z-old"],
        query: "needle",
        mode: "keyword",
        order: "legacy",
        kinds: ["user", "assistant"],
      });
      expect(
        legacy.candidates.map(({ threadId, itemId, matchRank }) => [threadId, itemId, matchRank]),
      ).toEqual([
        ["a-recent", "a-user", 0],
        ["a-recent", "z-user", 0],
        ["z-old", "user", 0],
        ["a-recent", "assistant", 1],
      ]);

      const distinct = yield* query({
        threadIds: ["m-title", "a-recent", "z-old"],
        query: "needle",
        mode: "keyword",
        distinctThreads: true,
      });
      expect(distinct.candidates.map(({ threadId, itemId }) => [threadId, itemId])).toEqual([
        ["m-title", "thread"],
        ["a-recent", "a-user"],
        ["z-old", "user"],
      ]);
      const nextDistinct = yield* query({
        threadIds: ["m-title", "a-recent", "z-old"],
        query: "needle",
        mode: "keyword",
        distinctThreads: true,
        limit: 1,
        after: {
          matchRank: distinct.candidates[0]!.matchRank,
          threadUpdatedAt: distinct.candidates[0]!.threadUpdatedAt,
          threadId: distinct.candidates[0]!.threadId,
          itemId: distinct.candidates[0]!.itemId,
        },
      });
      expect(nextDistinct.candidates.map(({ threadId, itemId }) => [threadId, itemId])).toEqual([
        ["a-recent", "a-user"],
      ]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("publishes staged parts only after exact coverage and rejects overlap", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      const whole = document("thread-parts", "split", "start needle");
      const split = parts(whole, 6);
      const second = split[1]!;
      yield* deliver(
        delivery({
          id: "split-tail",
          threadId: "thread-parts",
          revision: 1,
          parts: [second],
        }),
      );
      yield* deliver(
        delivery({
          id: "split-tail-retry",
          threadId: "thread-parts",
          revision: 1,
          parts: [second],
        }),
      );
      expect(
        (yield* query({
          threadIds: ["thread-parts"],
          query: "start needle",
          mode: "keyword",
        })).candidates,
      ).toEqual([]);

      yield* deliver(
        delivery({
          id: "split-head",
          threadId: "thread-parts",
          revision: 1,
          parts: [split[0]!],
        }),
      );
      expect(
        (yield* query({
          threadIds: ["thread-parts"],
          query: "start needle",
          mode: "keyword",
        })).candidates.map(({ itemId }) => itemId),
      ).toEqual(["split"]);

      yield* deliver(
        delivery({
          id: "gap-first",
          threadId: "thread-parts",
          revision: 2,
          parts: [{ ...document("thread-parts", "gap", "ab"), offset: 0, totalLength: 4 }],
        }),
      );
      yield* deliver(
        delivery({
          id: "gap-last",
          threadId: "thread-parts",
          revision: 2,
          parts: [{ ...document("thread-parts", "gap", "d"), offset: 3, totalLength: 4 }],
        }),
      );
      expect(
        (yield* query({
          threadIds: ["thread-parts"],
          query: "abcd",
          mode: "literal",
        })).candidates,
      ).toEqual([]);
      yield* deliver(
        delivery({
          id: "gap-fill",
          threadId: "thread-parts",
          revision: 2,
          parts: [{ ...document("thread-parts", "gap", "c"), offset: 2, totalLength: 4 }],
        }),
      );
      expect(
        (yield* query({
          threadIds: ["thread-parts"],
          query: "abcd",
          mode: "literal",
        })).candidates.map(({ itemId }) => itemId),
      ).toEqual(["gap"]);

      yield* deliver(
        delivery({
          id: "overlap-first",
          threadId: "thread-parts",
          revision: 3,
          parts: [{ ...document("thread-parts", "overlap", "abcd"), offset: 0, totalLength: 6 }],
        }),
      );
      yield* deliver(
        delivery({
          id: "overlap-second",
          threadId: "thread-parts",
          revision: 3,
          parts: [{ ...document("thread-parts", "overlap", "def"), offset: 3, totalLength: 6 }],
        }),
      );
      expect(
        (yield* query({
          threadIds: ["thread-parts"],
          query: "abcdef",
          mode: "literal",
        })).candidates,
      ).toEqual([]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect(
    "keeps published revision and indexed-through metadata until replacement coverage is complete",
    () =>
      Effect.gen(function* () {
        yield* SqliteSearchIndex.initialize(home);
        yield* deliver(
          delivery({
            id: "published-v1",
            threadId: "thread-metadata",
            revision: 1,
            sourceSequence: 10,
            documents: [document("thread-metadata", "item", "old published phrase")],
          }),
        );
        const replacement = parts(document("thread-metadata", "item", "new published phrase"), 4);

        yield* deliver(
          delivery({
            id: "replacement-tail",
            threadId: "thread-metadata",
            revision: 2,
            sourceSequence: 99,
            parts: [replacement[replacement.length - 1]!],
          }),
        );
        const oldWhileStaging = yield* query({
          threadIds: ["thread-metadata"],
          query: "old published phrase",
          mode: "literal",
        });
        expect(
          oldWhileStaging.candidates.map(({ revision, sourceSequence }) => [
            revision,
            sourceSequence,
          ]),
        ).toEqual([[1, 10]]);

        yield* deliver(
          delivery({
            id: "replacement-prefix",
            threadId: "thread-metadata",
            revision: 2,
            sourceSequence: 99,
            parts: replacement.slice(0, -1),
          }),
        );
        expect(
          (yield* query({
            threadIds: ["thread-metadata"],
            query: "old published phrase",
            mode: "literal",
          })).candidates,
        ).toEqual([]);
        const current = yield* query({
          threadIds: ["thread-metadata"],
          query: "new published phrase",
          mode: "literal",
        });
        expect(
          current.candidates.map(({ revision, sourceSequence }) => [revision, sourceSequence]),
        ).toEqual([[2, 99]]);
      }).pipe(Effect.provide(layerForTest())),
  );

  it.effect(
    "converts legacy rows in bounded steps and preserves them when final coverage is incomplete",
    () =>
      Effect.gen(function* () {
        yield* SqliteSearchIndex.initialize(home);
        const sql = yield* SqlClient.SqlClient;
        const insertLegacyDocument = (threadId: string, itemId: string, text: string) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO search_threads
          (thread_id, title, archived, deleted, revision, source_sequence, complete, updated_at, complete_requested)
          VALUES (${threadId}, ${`Legacy ${threadId}`}, 0, 0, 9, 99, 0, '', 0)`;
            const [row] = yield* sql<{ readonly id: number }>`INSERT INTO search_documents
          (thread_id, item_id, entry_id, run_id, position, kind, text, search_text,
            literal_text, created_at, revision)
          VALUES (${threadId}, ${itemId}, ${`entry-${itemId}`}, NULL, 1, 'user', ${text},
            ${text.toLowerCase()}, ${text.toLowerCase()}, NULL, 8) RETURNING id`;
            if (row === undefined) throw new Error("Legacy row insert did not return an id.");
            yield* sql`INSERT INTO search_documents_fts (rowid, search_text)
          VALUES (${row.id}, ${text.toLowerCase()})`;
            return row.id;
          });

        const legacyText = `before ${"x".repeat(20_000)} legacyneedle`;
        const legacyId = yield* insertLegacyDocument("legacy-ok", "ok", legacyText);
        const initial = yield* query({
          threadIds: ["legacy-ok"],
          query: "legacyneedle",
          mode: "keyword",
        });
        expect(
          initial.candidates.map(({ revision, sourceSequence }) => [revision, sourceSequence]),
        ).toEqual([[8, 0]]);

        expect(yield* SqliteSearchIndex.advanceLegacyConversion).toBe(true);
        const whileConverting = yield* query({
          threadIds: ["legacy-ok"],
          query: "legacyneedle",
          mode: "keyword",
        });
        expect(whileConverting.candidates.map(({ itemId }) => itemId)).toEqual(["ok"]);
        const [legacy] = yield* sql<{
          readonly text: string;
        }>`SELECT text FROM search_documents WHERE id = ${legacyId}`;
        expect(legacy?.text).toBe(legacyText);

        let more = true;
        let steps = 1;
        while (more && steps < 20) {
          more = yield* SqliteSearchIndex.advanceLegacyConversion;
          steps += 1;
        }
        expect(more).toBe(false);
        expect(steps).toBeGreaterThan(5);
        const converted = yield* query({
          threadIds: ["legacy-ok"],
          query: "legacyneedle",
          mode: "keyword",
        });
        expect(
          converted.candidates.map(({ itemId, revision, sourceSequence }) => [
            itemId,
            revision,
            sourceSequence,
          ]),
        ).toEqual([["ok", 8, 0]]);
        const [cleared] = yield* sql<{
          readonly text: string;
          readonly part_count: number;
        }>`SELECT d.text,
          (SELECT COUNT(*) FROM search_document_parts p WHERE p.document_id = d.id) AS part_count
        FROM search_documents d WHERE d.id = ${legacyId}`;
        expect(cleared?.text).toBe("");
        expect(cleared?.part_count).toBe(3);

        const faultText = `before ${"y".repeat(20_000)} faultneedle`;
        const faultId = yield* insertLegacyDocument("legacy-gap", "gap", faultText);
        let stage: string | undefined;
        let faultSteps = 0;
        while (stage !== "verifying" && faultSteps < 20) {
          yield* SqliteSearchIndex.advanceLegacyConversion;
          const [conversion] = yield* sql<{ readonly stage: string }>`SELECT stage
          FROM search_document_conversion WHERE document_id = ${faultId}`;
          stage = conversion?.stage;
          faultSteps += 1;
        }
        expect(stage).toBe("verifying");
        const [middle] = yield* sql<{ readonly id: number }>`SELECT id FROM search_document_parts
        WHERE document_id = ${faultId} AND part_index = 1`;
        expect(middle).toBeDefined();
        yield* sql`DELETE FROM search_document_parts_fts WHERE rowid = ${middle!.id}`;
        yield* sql`DELETE FROM search_document_parts WHERE id = ${middle!.id}`;
        expect(yield* SqliteSearchIndex.advanceLegacyConversion).toBe(false);
        const [failedConversion] = yield* sql<{ readonly stage: string }>`SELECT stage
        FROM search_document_conversion WHERE document_id = ${faultId}`;
        const [preserved] = yield* sql<{
          readonly text: string;
        }>`SELECT text FROM search_documents WHERE id = ${faultId}`;
        expect(failedConversion?.stage).toBe("invalid");
        expect(preserved?.text).toBe(faultText);
        expect(
          (yield* query({
            threadIds: ["legacy-gap"],
            query: "faultneedle",
            mode: "keyword",
          })).candidates.map(({ itemId }) => itemId),
        ).toEqual(["gap"]);

        // SQLite text length/substr stop at NUL; byte coverage must prevent clearing the tail.
        const nulText = "prefix\0suffix";
        const nulId = yield* insertLegacyDocument("legacy-nul", "nul", nulText);
        for (let step = 0; step < 8; step++) {
          if (!(yield* SqliteSearchIndex.advanceLegacyConversion)) break;
        }
        const [nulRow] = yield* sql<{ readonly text: string }>`SELECT text
        FROM search_documents WHERE id = ${nulId}`;
        expect(nulRow?.text).toBe(nulText);
      }).pipe(Effect.provide(layerForTest())),
  );

  it.effect(
    "searches large bounded parts across distant terms, literal seams, accents and surrogate pairs",
    () =>
      Effect.gen(function* () {
        yield* SqliteSearchIndex.initialize(home);
        const largeText = `alpha ${"x".repeat(1_050_000)} Cafe\u0301 ${"x".repeat(1_050_000)} omega`;
        expect(largeText.length).toBeGreaterThan(2_000_000);
        const large = parts(document("thread-large", "large", largeText));
        const seamText = `${"p".repeat(15_998)}crossboundary${"q".repeat(20)}`;
        const seam = parts(document("thread-large", "seam", seamText));
        const surrogate = parts(document("thread-large", "surrogate", "A😀B"), 2);
        yield* deliver(
          delivery({
            id: "large-parts",
            threadId: "thread-large",
            revision: 1,
            parts: [...large, ...seam, ...surrogate],
          }),
        );

        expect(
          (yield* query({
            threadIds: ["thread-large"],
            query: "alpha omega",
            mode: "keyword",
          })).candidates.map(({ itemId }) => itemId),
        ).toEqual(["large"]);
        expect(
          (yield* query({
            threadIds: ["thread-large"],
            query: "CAFÉ",
            mode: "keyword",
          })).candidates.map(({ itemId }) => itemId),
        ).toEqual(["large"]);
        expect(
          (yield* query({
            threadIds: ["thread-large"],
            query: "crossboundary",
            mode: "literal",
          })).candidates.map(({ itemId }) => itemId),
        ).toEqual(["seam"]);
        expect(
          (yield* query({
            threadIds: ["thread-large"],
            query: "😀B",
            mode: "literal",
          })).candidates.map(({ itemId }) => itemId),
        ).toEqual(["surrogate"]);

        const sql = yield* SqlClient.SqlClient;
        const [sizes] = yield* sql<{
          readonly largestPartBytes: number;
          readonly largestLiteralWindowBytes: number;
          readonly largestKeywordWindowBytes: number;
          readonly largestLegacyDocumentBytes: number;
        }>`SELECT
        (SELECT MAX(length(CAST(text AS BLOB))) FROM search_document_parts) AS largestPartBytes,
        (SELECT MAX(length(CAST(literal_text AS BLOB))) FROM search_document_parts) AS largestLiteralWindowBytes,
        MAX(
          COALESCE((SELECT MAX(length(CAST(search_text AS BLOB))) FROM search_documents_fts), 0),
          COALESCE((SELECT MAX(length(CAST(search_text AS BLOB))) FROM search_document_parts_fts), 0)
        ) AS largestKeywordWindowBytes,
        (SELECT MAX(MAX(length(CAST(text AS BLOB)), length(CAST(search_text AS BLOB)),
          length(CAST(literal_text AS BLOB)))) FROM search_documents) AS largestLegacyDocumentBytes`;
        expect(sizes?.largestPartBytes).toBeLessThanOrEqual(64_000);
        expect(sizes?.largestLiteralWindowBytes).toBeLessThan(512 * 1024);
        expect(sizes?.largestKeywordWindowBytes).toBeLessThan(512 * 1024);
        expect(sizes?.largestLegacyDocumentBytes).toBe(0);
      }).pipe(Effect.provide(layerForTest())),
  );

  it.effect(
    "keeps same-revision backfill pages, closes progress only at completion, and fences tombstones",
    () =>
      Effect.gen(function* () {
        yield* SqliteSearchIndex.initialize(home);
        yield* deliver(
          delivery({
            id: "backfill-page-1",
            threadId: "thread-1",
            revision: 4,
            documents: [document("thread-1", "item-1", "first page")],
          }),
        );
        const pending = yield* SearchIndex.SearchIndex.use((index) =>
          index.progress(home, ["thread-1"]),
        );
        expect(pending).toEqual([{ threadId: "thread-1", revision: 4, complete: false }]);

        const secondPage = delivery({
          id: "backfill-page-2",
          threadId: "thread-1",
          revision: 4,
          documents: [document("thread-1", "item-2", "second page")],
        });
        yield* deliver(secondPage);
        yield* deliver(secondPage);
        yield* deliver(
          delivery({
            id: "backfill-page-3",
            threadId: "thread-1",
            revision: 4,
            documents: [document("thread-1", "item-3", "last page")],
            complete: true,
          }),
        );

        const closed = yield* SearchIndex.SearchIndex.use((index) =>
          index.progress(home, ["thread-1"]),
        );
        expect(closed).toEqual([{ threadId: "thread-1", revision: 4, complete: true }]);

        // A live write queued before the backfill finished cannot undo initial coverage.
        yield* deliver(
          delivery({
            id: "queued-live-write",
            threadId: "thread-1",
            revision: 5,
            documents: [document("thread-1", "item-4", "new live item")],
          }),
        );
        expect(
          yield* SearchIndex.SearchIndex.use((index) => index.progress(home, ["thread-1"])),
        ).toEqual([{ threadId: "thread-1", revision: 5, complete: true }]);

        yield* deliver(
          delivery({
            id: "rollback",
            threadId: "thread-1",
            revision: 5,
            removed: ["item-2"],
            complete: true,
          }),
        );
        yield* deliver(
          delivery({
            id: "older-delivery-after-rollback",
            threadId: "thread-1",
            revision: 4,
            documents: [document("thread-1", "item-2", "old second page")],
          }),
        );
        // A different same-revision page cannot resurrect an item removed by rollback.
        yield* deliver(
          delivery({
            id: "rollback-late-page",
            threadId: "thread-1",
            revision: 5,
            documents: [document("thread-1", "item-2", "second page")],
            complete: true,
          }),
        );
        const removed = yield* query({
          threadIds: ["thread-1"],
          query: "second page",
          mode: "literal",
        });
        expect(removed.candidates).toEqual([]);

        yield* deliver(
          delivery({
            id: "restored",
            threadId: "thread-1",
            revision: 6,
            documents: [document("thread-1", "item-2", "restored page")],
            complete: true,
          }),
        );
        const restored = yield* query({
          threadIds: ["thread-1"],
          query: "restored",
          mode: "keyword",
        });
        expect(restored.candidates.map((candidate) => candidate.itemId)).toEqual(["item-2"]);
      }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("sweeps each activated snapshot only after full replay coverage", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      const obsoleteText = "obsolete generation one text";
      yield* deliver(
        delivery({
          id: "gen-1-initial",
          threadId: "thread-snapshot",
          revision: 1,
          complete: true,
          documents: [
            document("thread-snapshot", "shared", "first generation shared text"),
            document("thread-snapshot", "old-only", obsoleteText),
          ],
        }),
      );
      const sql = yield* SqlClient.SqlClient;
      const [obsolete] = yield* sql<{ readonly id: number }>`SELECT id FROM search_documents
        WHERE thread_id = 'thread-snapshot' AND item_id = 'old-only'`;
      if (obsolete === undefined) throw new Error("Expected the obsolete snapshot row.");
      const [obsoletePart] = yield* sql<{
        readonly id: number;
      }>`SELECT id FROM search_document_parts
        WHERE document_id = ${obsolete.id}`;
      if (obsoletePart === undefined) throw new Error("Expected the obsolete indexed part.");
      yield* sql`INSERT INTO search_document_conversion
        (document_id, char_offset, unit_offset, total_chars, total_length, stage,
          next_part_index, next_index_part)
        VALUES (${obsolete.id}, 0, 0, ${obsoleteText.length}, ${obsoleteText.length}, 'reading', 0, 0)`;

      const first = delivery({
        id: "gen-1-snapshot",
        threadId: "thread-snapshot",
        revision: 2,
        complete: true,
        documents: [document("thread-snapshot", "shared", "first replay current text")],
        snapshot: { activation: "opaque-generation-one-a", page: 0, final: true },
      });
      yield* deliver(first);
      expect(
        (yield* query({
          threadIds: ["thread-snapshot"],
          query: "obsolete generation one",
          mode: "keyword",
        })).candidates,
      ).toEqual([]);
      const [cleaned] = yield* sql<{
        readonly document: number;
        readonly parts: number;
        readonly conversion: number;
        readonly documentFts: number;
        readonly partFts: number;
      }>`SELECT
        (SELECT COUNT(*) FROM search_documents WHERE id = ${obsolete.id}) AS document,
        (SELECT COUNT(*) FROM search_document_parts WHERE document_id = ${obsolete.id}) AS parts,
        (SELECT COUNT(*) FROM search_document_conversion WHERE document_id = ${obsolete.id}) AS conversion,
        (SELECT COUNT(*) FROM search_documents_fts WHERE rowid = ${obsolete.id}) AS documentFts,
        (SELECT COUNT(*) FROM search_document_parts_fts WHERE rowid = ${obsoletePart.id}) AS partFts`;
      expect(cleaned).toEqual({
        document: 0,
        parts: 0,
        conversion: 0,
        documentFts: 0,
        partFts: 0,
      });

      yield* deliver(
        delivery({
          id: "gen-2-snapshot",
          threadId: "thread-snapshot",
          revision: 3,
          complete: true,
          documents: [
            document("thread-snapshot", "shared", "generation two shared text"),
            document("thread-snapshot", "gen-2-only", "generation two only text"),
          ],
          snapshot: { activation: "opaque-generation-two-a", page: 0, final: true },
        }),
      );
      yield* deliver(
        delivery({
          id: "gen-1-return-snapshot",
          threadId: "thread-snapshot",
          revision: 4,
          complete: true,
          documents: [
            document("thread-snapshot", "shared", "generation one restored text"),
            document("thread-snapshot", "gen-1-current", "generation one current text"),
          ],
          snapshot: { activation: "opaque-generation-one-b", page: 0, final: true },
        }),
      );

      const staleGeneration = yield* query({
        threadIds: ["thread-snapshot"],
        query: "generation two only",
        mode: "keyword",
      });
      const restoredGeneration = yield* query({
        threadIds: ["thread-snapshot"],
        query: "generation one current",
        mode: "keyword",
      });
      const progress = yield* SearchIndex.SearchIndex.use((index) =>
        index.progress(home, ["thread-snapshot"]),
      );
      expect(staleGeneration.candidates).toEqual([]);
      expect(restoredGeneration.candidates.map(({ itemId }) => itemId)).toEqual(["gen-1-current"]);
      expect(progress).toEqual([
        {
          threadId: "thread-snapshot",
          revision: 4,
          complete: true,
          activation: "opaque-generation-one-b",
        },
      ]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("retains published rows until contiguous snapshot pages and all item parts land", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "before-snapshot",
          threadId: "thread-partial-snapshot",
          revision: 8,
          complete: true,
          documents: [document("thread-partial-snapshot", "old", "old published snapshot text")],
        }),
      );

      yield* deliver(
        delivery({
          id: "snapshot-page-zero",
          threadId: "thread-partial-snapshot",
          revision: 9,
          parts: [
            {
              ...document("thread-partial-snapshot", "new", "newneedle"),
              text: "new",
              offset: 0,
              totalLength: 9,
            },
          ],
          snapshot: { activation: "snapshot-partial", page: 0, final: false },
        }),
      );

      const whilePartial = yield* query({
        threadIds: ["thread-partial-snapshot"],
        query: "old published snapshot",
        mode: "keyword",
      });
      const partialProgress = yield* SearchIndex.SearchIndex.use((index) =>
        index.progress(home, ["thread-partial-snapshot"]),
      );
      expect(whilePartial.candidates.map(({ itemId }) => itemId)).toEqual(["old"]);
      expect(partialProgress).toEqual([
        {
          threadId: "thread-partial-snapshot",
          revision: 9,
          complete: false,
          activation: "snapshot-partial",
        },
      ]);

      yield* deliver(
        delivery({
          id: "snapshot-page-one-final",
          threadId: "thread-partial-snapshot",
          revision: 9,
          complete: true,
          parts: [
            {
              ...document("thread-partial-snapshot", "new", "newneedle"),
              text: "needle",
              offset: 3,
              totalLength: 9,
            },
          ],
          snapshot: { activation: "snapshot-partial", page: 1, final: true },
        }),
      );

      const afterSnapshot = yield* query({
        threadIds: ["thread-partial-snapshot"],
        query: "old published snapshot",
        mode: "keyword",
      });
      const landedParts = yield* query({
        threadIds: ["thread-partial-snapshot"],
        query: "newneedle",
        mode: "keyword",
      });
      expect(afterSnapshot.candidates).toEqual([]);
      expect(landedParts.candidates.map(({ itemId }) => itemId)).toEqual(["new"]);
    }).pipe(Effect.provide(layerForTest())),
  );

  it.effect("accepts an older snapshot after newer live writes without rolling them back", () =>
    Effect.gen(function* () {
      yield* SqliteSearchIndex.initialize(home);
      yield* deliver(
        delivery({
          id: "old-published-before-snapshot",
          threadId: "thread-late-snapshot",
          revision: 2,
          complete: true,
          documents: [
            document("thread-late-snapshot", "stale", "stale published row text"),
            document("thread-late-snapshot", "snapshot-item", "snapshot current item"),
          ],
        }),
      );
      yield* deliver(
        delivery({
          id: "snapshot-page-before-live",
          threadId: "thread-late-snapshot",
          revision: 4,
          documents: [document("thread-late-snapshot", "snapshot-item", "snapshot current item")],
          snapshot: { activation: "snapshot-before-live", page: 0, final: false },
        }),
      );
      yield* deliver(
        delivery({
          id: "newer-live-after-snapshot-start",
          threadId: "thread-late-snapshot",
          revision: 5,
          complete: true,
          documents: [document("thread-late-snapshot", "live", "newer live item")],
        }),
      );
      yield* deliver(
        delivery({
          id: "snapshot-final-after-live",
          threadId: "thread-late-snapshot",
          revision: 4,
          complete: true,
          snapshot: { activation: "snapshot-before-live", page: 1, final: true },
        }),
      );
      yield* deliver(
        delivery({
          id: "late-old-snapshot-page",
          threadId: "thread-late-snapshot",
          revision: 3,
          complete: true,
          documents: [document("thread-late-snapshot", "stale", "stale published row text")],
          snapshot: { activation: "older-activation", page: 0, final: true },
        }),
      );

      const stale = yield* query({
        threadIds: ["thread-late-snapshot"],
        query: "stale published row",
        mode: "keyword",
      });
      const current = yield* query({
        threadIds: ["thread-late-snapshot"],
        query: "newer live item",
        mode: "keyword",
      });
      expect(stale.candidates).toEqual([]);
      expect(current.candidates.map(({ itemId }) => itemId)).toEqual(["live"]);
    }).pipe(Effect.provide(layerForTest())),
  );
});
