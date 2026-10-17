import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SearchIndex from "../SearchIndex.ts";
import * as SqliteSearchIndex from "./SqliteSearchIndex.ts";

const home = { ownerId: "owner-1", projectId: "project-1" };

const document = (threadId: string, itemId: string, text: string): SearchIndex.SearchDocument => ({
  threadId,
  itemId,
  entryId: `entry-${itemId}`,
  runId: null,
  position: 1,
  kind: "user",
  text,
  createdAt: null,
});

const delivery = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly revision: number;
  readonly documents?: ReadonlyArray<SearchIndex.SearchDocument>;
  readonly removed?: ReadonlyArray<string>;
  readonly complete?: boolean;
}): SearchIndex.SearchDelivery => ({
  home,
  thread: {
    threadId: input.threadId,
    title: `Title ${input.threadId}`,
    archived: false,
    deleted: false,
  },
  revision: input.revision,
  sourceSequence: input.revision,
  deliveryId: input.id,
  documents: input.documents ?? [],
  removed: input.removed ?? [],
  complete: input.complete ?? false,
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
  readonly distinctThreads?: boolean;
  readonly after?: { readonly threadId: string; readonly itemId: string } | null;
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
        after: { threadId: "z-allowed", itemId: "item-1" },
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
      expect(current.candidates.map((candidate) => candidate.text)).toEqual(["current wording"]);
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
        after: { threadId: "thread-a", itemId: "item-a" },
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
});
