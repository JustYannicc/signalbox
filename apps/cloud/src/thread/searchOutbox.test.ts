import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as SearchIndex from "../search/SearchIndex.ts";
import * as ThreadStore from "./ThreadStore.ts";

const home = { ownerId: "owner-1", projectId: "project-1" };
const thread = {
  threadId: "thread-1",
  title: "Search outbox",
  archived: false,
  deleted: false,
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
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const createStore = () =>
        Effect.map(
          Layer.build(
            Layer.fresh(ThreadStore.layer).pipe(Layer.provide(Layer.succeedContext(database))),
          ),
          (context) => Context.get(context, ThreadStore.ThreadStore),
        );
      const store = yield* createStore();
      yield* store.initialize;
      return yield* use(store, createStore);
    }),
  );

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
        const historical = Array.from({ length: 50 }, (_, index) =>
          document(`history-${String(index).padStart(2, "0")}`, index + 1, `history ${index}`),
        );
        yield* store.requestSearchBackfill({
          home,
          thread,
          documents: historical,
          sourceSequence: 9,
        });

        const firstPage = yield* store.pendingSearchDelivery;
        expect(firstPage?.documents).toHaveLength(48);
        expect(firstPage?.complete).toBe(false);

        yield* store.commit({
          head: 10,
          events: [],
          summaryChanged: false,
          searchDeliveries: [
            {
              home,
              thread,
              documents: [document("live-item", 51, "new live message")],
              removed: [],
              complete: false,
              sourceSequence: 10,
            },
          ],
        });

        const pageOne = firstPage!;
        expect(pageOne.sourceSequence).toBe(9);
        expect(pageOne.documents.map(({ itemId }) => itemId)).toEqual(
          historical.slice(0, 48).map(({ itemId }) => itemId),
        );
        yield* store.acknowledgeSearchDelivery(pageOne.revision, pageOne.deliveryId);

        const secondPage = yield* store.pendingSearchDelivery;
        expect(secondPage?.revision).toBe(pageOne.revision);
        expect(secondPage?.sourceSequence).toBe(9);
        expect(secondPage?.documents.map(({ itemId }) => itemId)).toEqual(
          historical.slice(48).map(({ itemId }) => itemId),
        );
        expect(secondPage?.complete).toBe(true);
        yield* store.acknowledgeSearchDelivery(secondPage!.revision, secondPage!.deliveryId);

        const liveUpdate = yield* store.pendingSearchDelivery;
        expect(liveUpdate?.revision).toBeGreaterThan(secondPage!.revision);
        expect(liveUpdate?.sourceSequence).toBe(10);
        expect(liveUpdate?.documents.map(({ itemId }) => itemId)).toEqual(["live-item"]);
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
        expect(firstDelivery?.complete).toBe(true);
      }),
    ),
  );
});
