import { describe, expect, it } from "@effect/vitest";
import { EventId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";

import * as SearchIndex from "../search/SearchIndex.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { deliverPendingSearch } from "./searchOutbox.ts";

const home = { ownerId: "owner-1", projectId: "project-1" };
const thread = {
  threadId: "thread-1",
  title: "Search outbox",
  archived: false,
  deleted: false,
  updatedAt: "2026-10-17T12:00:00.000Z",
};

const document = (itemId: string, position: number, text: string): SearchIndex.SearchDocument => ({
  threadId: thread.threadId,
  itemId,
  entryId: `entry-${itemId}`,
  runId: null,
  position,
  kind: "user",
  text,
  createdAt: null,
});

type Store = ThreadStore.ThreadStore["Service"];

/** Rebuild the store service over one real SQLite connection, as a DO wake-up does. */
const withStore = <A, E>(
  use: (
    store: Store,
    restart: () => Effect.Effect<Store, never, Scope.Scope>,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const sql = Context.get(database, SqlClient.SqlClient);
      const createStore = () =>
        Effect.map(
          Layer.build(
            Layer.fresh(ThreadStore.layer).pipe(Layer.provide(Layer.succeedContext(database))),
          ),
          (context) => Context.get(context, ThreadStore.ThreadStore),
        );
      const store = yield* createStore();
      yield* store.initialize;
      return yield* use(store, createStore, sql);
    }),
  );

const deliveryRowSize = (row: {
  readonly revision: number;
  readonly page: number;
  readonly delivery_id: string;
  readonly delivery: string;
}) =>
  new TextEncoder().encode(
    JSON.stringify({
      revision: row.revision,
      page: row.page,
      deliveryId: row.delivery_id,
      delivery: row.delivery,
    }),
  ).byteLength;

const SEARCH_DELIVERY_MAX_BYTES = 256 * 1024;

describe("ThreadStore search outbox", () => {
  it.effect(
    "keeps a pending delivery stable across restart and acknowledges only its revision and ID",
    () =>
      withStore((store, restart) =>
        Effect.gen(function* () {
          yield* store.commit({
            head: 0,
            events: [],
            summaryChanged: false,
            searchDeliveries: [
              {
                home,
                thread,
                documents: [document("item-1", 1, "durable pending text")],
                removed: [],
                complete: true,
                sourceSequence: 0,
              },
            ],
          });
          const pending = yield* store.pendingSearchDelivery;
          expect(pending).not.toBeNull();
          expect(pending?.thread.updatedAt).toBe(thread.updatedAt);

          const restartedStore = yield* restart();
          yield* restartedStore.initialize;
          expect(yield* restartedStore.pendingSearchDelivery).toEqual(pending);

          const delivery = pending!;
          yield* restartedStore.acknowledgeSearchDelivery(
            delivery.revision + 1,
            delivery.deliveryId,
          );
          yield* restartedStore.acknowledgeSearchDelivery(
            delivery.revision,
            `${delivery.deliveryId}-wrong`,
          );
          expect(yield* restartedStore.pendingSearchDelivery).toEqual(delivery);
          expect((yield* restartedStore.searchOutbox).delivered).toBe(0);

          yield* restartedStore.acknowledgeSearchDelivery(delivery.revision, delivery.deliveryId);
          expect(yield* restartedStore.pendingSearchDelivery).toBeNull();
          expect((yield* restartedStore.searchOutbox).delivered).toBe(delivery.revision);
        }),
      ),
  );

  it.effect("pages a backfill before a later live update for a pre-search thread", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const historical = Array.from({ length: 70 }, (_, index) =>
          document(`history-${String(index).padStart(2, "0")}`, index + 1, `history ${index}`),
        );
        yield* store.requestSearchBackfill({
          home,
          thread,
          documents: historical,
          sourceSequence: 9,
        });

        const firstPage = yield* store.pendingSearchDelivery;
        expect(firstPage?.thread.updatedAt).toBe(thread.updatedAt);
        expect(firstPage?.documents).toHaveLength(0);
        expect(firstPage?.parts).toHaveLength(64);
        expect(firstPage?.complete).toBe(false);

        yield* store.commit({
          head: 10,
          events: [],
          summaryChanged: false,
          searchDeliveries: [
            {
              home,
              thread,
              documents: [document("live-item", 71, "new live message")],
              removed: [],
              complete: false,
              sourceSequence: 10,
            },
          ],
        });

        const pageOne = firstPage!;
        expect(pageOne.sourceSequence).toBe(9);
        expect(pageOne.parts?.map(({ itemId }) => itemId)).toEqual(
          historical.slice(0, 64).map(({ itemId }) => itemId),
        );
        yield* store.acknowledgeSearchDelivery(pageOne.revision, pageOne.deliveryId);

        const secondPage = yield* store.pendingSearchDelivery;
        expect(secondPage?.revision).toBe(pageOne.revision);
        expect(secondPage?.sourceSequence).toBe(9);
        expect(secondPage?.parts?.map(({ itemId }) => itemId)).toEqual(
          historical.slice(64).map(({ itemId }) => itemId),
        );
        expect(secondPage?.complete).toBe(true);
        yield* store.acknowledgeSearchDelivery(secondPage!.revision, secondPage!.deliveryId);

        const liveUpdate = yield* store.pendingSearchDelivery;
        expect(liveUpdate?.revision).toBeGreaterThan(secondPage!.revision);
        expect(liveUpdate?.sourceSequence).toBe(10);
        expect(liveUpdate?.parts?.map(({ itemId }) => itemId)).toEqual(["live-item"]);
        expect(liveUpdate?.complete).toBe(false);
      }),
    ),
  );

  it.effect("marks a new thread complete on its first live write", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const newThread = { ...thread, threadId: "new-thread" };
        yield* store.commit({
          head: 0,
          events: [],
          summaryChanged: false,
          searchDeliveries: [
            {
              home,
              thread: newThread,
              documents: [
                { ...document("first-item", 1, "first message"), threadId: newThread.threadId },
              ],
              removed: [],
              complete: true,
              sourceSequence: 0,
            },
          ],
        });

        const firstDelivery = yield* store.pendingSearchDelivery;
        expect(firstDelivery?.thread.threadId).toBe(newThread.threadId);
        expect(firstDelivery?.documents).toHaveLength(0);
        expect(firstDelivery?.parts?.map(({ itemId }) => itemId)).toEqual(["first-item"]);
        expect(firstDelivery?.complete).toBe(true);
      }),
    ),
  );

  it.effect("stores large live updates as bounded delivery envelopes and rows", () =>
    withStore((store, _restart, sql) =>
      Effect.gen(function* () {
        const largeDocuments = [
          ...Array.from({ length: 48 }, (_, index) =>
            document(`history-${index}`, index + 1, "x".repeat(45 * 1024)),
          ),
          document("oversized-item", 49, '"\\\n🙂'.repeat(430_000)),
        ];
        yield* store.commit({
          head: 0,
          events: [],
          summaryChanged: false,
          searchDeliveries: [
            {
              home,
              thread,
              documents: largeDocuments,
              removed: [],
              complete: true,
              sourceSequence: 0,
            },
          ],
        });

        const rows = yield* sql<{
          readonly revision: number;
          readonly page: number;
          readonly delivery_id: string;
          readonly delivery: string;
        }>`SELECT revision, page, delivery_id, delivery FROM search_outbox ORDER BY page`;
        expect(rows.length).toBeGreaterThan(1);
        const partsByItem = new Map<string, Array<SearchIndex.SearchDocumentPart>>();
        for (const row of rows) {
          expect(new TextEncoder().encode(row.delivery).byteLength).toBeLessThanOrEqual(
            SEARCH_DELIVERY_MAX_BYTES,
          );
          expect(deliveryRowSize(row)).toBeLessThanOrEqual(SEARCH_DELIVERY_MAX_BYTES);
          const delivery = JSON.parse(row.delivery) as SearchIndex.SearchDelivery;
          expect(delivery.documents).toHaveLength(0);
          for (const part of delivery.parts ?? []) {
            expect(part.text.length).toBeLessThanOrEqual(16 * 1024);
            const itemParts = partsByItem.get(part.itemId) ?? [];
            itemParts.push(part);
            partsByItem.set(part.itemId, itemParts);
          }
        }

        for (const source of largeDocuments) {
          const parts = partsByItem.get(source.itemId) ?? [];
          parts.sort((left, right) => left.offset - right.offset);
          expect(parts.map(({ offset }) => offset)).toEqual(
            parts.map((part, index) =>
              index === 0 ? 0 : parts[index - 1]!.offset + parts[index - 1]!.text.length,
            ),
          );
          expect(parts.at(-1)?.totalLength).toBe(source.text.length);
          expect(parts.map(({ text }) => text).join("")).toBe(source.text);
        }
      }),
    ),
  );

  it.effect("resumes queued legacy delivery conversion without losing or duplicating payload", () =>
    withStore((store, restart, sql) =>
      Effect.gen(function* () {
        const sourceText = "legacy🙂".repeat(90_000);
        const legacy: SearchIndex.SearchDelivery = {
          home,
          thread,
          revision: 1,
          sourceSequence: 7,
          deliveryId: "legacy-source:1",
          documents: [document("legacy-item", 1, sourceText)],
          removed: ["removed-item"],
          complete: true,
        };
        yield* sql`INSERT INTO search_outbox (revision, page, delivery_id, delivery, active)
          VALUES (1, 0, ${legacy.deliveryId}, ${JSON.stringify(legacy)}, 1)`;

        let currentStore = store;
        const converted: Array<SearchIndex.SearchDelivery> = [];
        for (let page = 0; page < 10; page += 1) {
          const pending = yield* currentStore.pendingSearchDelivery;
          if (pending === null) break;
          const restartedStore = yield* restart();
          yield* restartedStore.initialize;
          expect(yield* restartedStore.pendingSearchDelivery).toEqual(pending);
          converted.push(pending);

          const convertedRow = yield* sql<{
            readonly revision: number;
            readonly page: number;
            readonly delivery_id: string;
            readonly delivery: string;
          }>`SELECT revision, page, delivery_id, delivery FROM search_outbox
            WHERE delivery_id = ${pending.deliveryId}`;
          expect(convertedRow).toHaveLength(1);
          expect(
            new TextEncoder().encode(convertedRow[0]!.delivery).byteLength,
          ).toBeLessThanOrEqual(SEARCH_DELIVERY_MAX_BYTES);
          expect(deliveryRowSize(convertedRow[0]!)).toBeLessThanOrEqual(SEARCH_DELIVERY_MAX_BYTES);

          const source = yield* sql<{ readonly active: number }>`SELECT active FROM search_outbox
            WHERE delivery_id = ${legacy.deliveryId}`;
          if (pending.complete) {
            expect(source).toHaveLength(0);
          } else {
            expect(source[0]?.active).toBe(0);
          }
          yield* restartedStore.acknowledgeSearchDelivery(pending.revision, pending.deliveryId);
          currentStore = restartedStore;
        }

        expect(converted.length).toBeGreaterThan(1);
        expect(converted.at(-1)?.complete).toBe(true);
        expect(yield* currentStore.pendingSearchDelivery).toBeNull();
        expect(yield* currentStore.hasPendingSearchDelivery).toBe(false);
        const parts = converted.flatMap(({ parts }) => [...(parts ?? [])]);
        parts.sort((left, right) => left.offset - right.offset);
        expect(parts.map(({ text }) => text).join("")).toBe(sourceText);
        expect(parts.map(({ offset }) => offset)).toEqual(
          parts.map((part, index) =>
            index === 0 ? 0 : parts[index - 1]!.offset + parts[index - 1]!.text.length,
          ),
        );
        expect(converted.flatMap(({ removed }) => removed)).toEqual(["removed-item"]);
      }),
    ),
  );

  it.effect("does not finish a legacy backfill before its later whole-document rows convert", () =>
    withStore((store, restart, sql) =>
      Effect.gen(function* () {
        yield* store.requestSearchBackfill({
          home,
          thread,
          sourceSequence: 3,
          documents: [],
        });
        const first = document("legacy-first", 1, "first ".repeat(8_000));
        const last = document("legacy-last", 2, "last legacy document");
        for (const value of [first, last]) {
          yield* sql`INSERT INTO search_backfill_documents (position, item_id, document)
            VALUES (${value.position}, ${value.itemId}, ${JSON.stringify(value)})`;
        }
        const firstPage = yield* store.pendingSearchDelivery;
        expect(firstPage?.complete).toBe(false);
        expect(firstPage?.parts?.map((part) => part.text).join("")).toBe(first.text);
        yield* store.acknowledgeSearchDelivery(firstPage!.revision, firstPage!.deliveryId);

        const restarted = yield* restart();
        yield* restarted.initialize;
        const lastPage = yield* restarted.pendingSearchDelivery;
        expect(lastPage?.parts?.map((part) => part.itemId)).toEqual([last.itemId]);
        expect(lastPage?.parts?.map((part) => part.text).join("")).toBe(last.text);
        expect(lastPage?.complete).toBe(true);
        yield* restarted.acknowledgeSearchDelivery(lastPage!.revision, lastPage!.deliveryId);
        expect((yield* restarted.searchOutbox).backfillComplete).toBe(true);
        expect(yield* restarted.pendingSearchDelivery).toBeNull();
      }),
    ),
  );

  it.effect(
    "deduplicates source activations and keeps an older acknowledgement from closing a new one",
    () =>
      withStore((store, restart) =>
        Effect.gen(function* () {
          const activation = (requestKey: string, itemId: string, sourceSequence: number) => ({
            home,
            thread,
            documents: [document(itemId, 1, `history ${itemId}`)],
            sourceSequence,
            requestKey,
          });
          const firstState = yield* store.requestSearchBackfill(
            activation("search:user:1:1", "generation-one", 1),
          );
          const firstDelivery = yield* store.pendingSearchDelivery;
          expect(firstDelivery?.revision).toBe(firstState.backfillRevision);

          const restartedStore = yield* restart();
          yield* restartedStore.initialize;
          const duplicate = yield* restartedStore.requestSearchBackfill(
            activation("search:user:1:1", "ignored-retry", 99),
          );
          expect(duplicate.backfillGeneration).toBe(firstState.backfillGeneration);
          expect(duplicate.backfillRevision).toBe(firstState.backfillRevision);

          const secondState = yield* restartedStore.requestSearchBackfill(
            activation("search:user:2:2", "generation-two", 2),
          );
          expect(secondState.backfillGeneration).toBe(firstState.backfillGeneration + 1);
          yield* restartedStore.acknowledgeSearchDelivery(
            firstDelivery!.revision,
            firstDelivery!.deliveryId,
          );
          const afterOldAck = yield* restartedStore.searchOutbox;
          expect(afterOldAck.backfillRequested).toBe(true);
          expect(afterOldAck.backfillComplete).toBe(false);
          expect(afterOldAck.backfillGeneration).toBe(secondState.backfillGeneration);

          const afterRestart = yield* restart();
          yield* afterRestart.initialize;
          const secondDelivery = yield* afterRestart.pendingSearchDelivery;
          expect(secondDelivery?.revision).toBe(secondState.backfillRevision);
          expect(secondDelivery?.parts?.map(({ itemId }) => itemId)).toEqual(["generation-two"]);
          expect(
            (yield* afterRestart.requestSearchBackfill(
              activation("search:user:2:2", "ignored-retry", 100),
            )).backfillGeneration,
          ).toBe(secondState.backfillGeneration);
        }),
      ),
  );

  it.effect("keeps source events moving while disabled search leaves its delivery pending", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const sourceEvent = {
          id: EventId.make("event-1"),
          type: "run.background-work-cancelled" as const,
          threadId: ThreadId.make(thread.threadId),
          runId: RunId.make("run-1"),
          occurredAt: DateTime.makeUnsafe("2026-10-17T00:00:00.000Z"),
          payload: {
            runId: RunId.make("run-1"),
            restartCancelledBackgroundWork: [],
          },
        };
        yield* store.commit({
          head: 0,
          events: [sourceEvent],
          summaryChanged: false,
          searchDeliveries: [
            {
              home,
              thread,
              documents: [document("pending-item", 1, "pending while disabled")],
              removed: [],
              complete: true,
              sourceSequence: 1,
            },
          ],
        });
        expect(yield* store.events(0)).toHaveLength(1);
        const before = yield* store.pendingSearchDelivery;
        expect(before).not.toBeNull();

        const disabledIndex = SearchIndex.SearchIndex.of({
          generation: "1",
          disabled: true,
          deliver: () => Effect.die(new Error("disabled search must not deliver")),
          query: () => Effect.succeed({ candidates: [], hasMore: false }),
          progress: () => Effect.succeed([]),
        });
        const untouchedEngine = new Proxy({} as ThreadEngine.ThreadEngine["Service"], {
          get: () => {
            throw new Error("disabled search must not read or acknowledge the thread engine");
          },
        });
        const didFinish = yield* Effect.provideService(
          Effect.provideService(deliverPendingSearch, SearchIndex.SearchIndex, disabledIndex),
          ThreadEngine.ThreadEngine,
          untouchedEngine,
        );

        expect(didFinish).toBe(true);
        expect(yield* store.pendingSearchDelivery).toEqual(before);
        expect(yield* store.events(0)).toHaveLength(1);
      }),
    ),
  );
});
