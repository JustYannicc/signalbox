import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Platform from "../platform.ts";
import * as SearchCursors from "./SearchCursors.ts";

const position = {
  version: 2 as const,
  fingerprint: "actor-grants-query",
  after: { matchRank: 1, threadUpdatedAt: "2026-10-17", threadId: "thread-a", itemId: "item-a" },
};

it.effect(
  "retains deduplication across service recreation and keeps old-page retries independent of later pages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
        const create = () =>
          SearchCursors.SearchCursors.pipe(
            Effect.provide(
              Layer.fresh(SearchCursors.layerSql).pipe(
                Layer.provide(Layer.mergeAll(Layer.succeedContext(database), Platform.layerCrypto)),
              ),
            ),
          );
        const first = yield* create();
        const firstToken = yield* first.save(position, null, ["thread-a"]);
        const restarted = yield* create();
        const cursor = yield* restarted.read(firstToken);
        expect(cursor).not.toBeNull();
        expect(yield* restarted.seen(cursor!)).toEqual(["thread-a"]);
        const secondToken = yield* restarted.save(position, cursor, ["thread-b"]);
        const secondCursor = yield* restarted.read(secondToken);
        expect(new Set(yield* restarted.seen(secondCursor!))).toEqual(
          new Set(["thread-a", "thread-b"]),
        );
        expect(yield* restarted.seen(cursor!)).toEqual(["thread-a"]);
        const retried = yield* restarted.save(position, cursor, ["thread-b"]);
        const retriedCursor = yield* restarted.read(retried);
        expect(new Set(yield* restarted.seen(retriedCursor!))).toEqual(
          new Set(["thread-a", "thread-b"]),
        );
      }),
    ),
);
