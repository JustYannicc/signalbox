import type { OrchestrationSearchThreadsResult } from "@t3tools/contracts";
import { ThreadSearchError } from "@t3tools/contracts/signalboxSearch";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as SearchBackfill from "./SearchBackfill.ts";
import * as SearchAuthority from "./SearchAuthority.ts";
import * as SearchIndex from "./SearchIndex.ts";
import * as SearchQuery from "./SearchQuery.ts";
import { ThreadSearch } from "./ThreadSearch.ts";

const unavailable = () => new ThreadSearchError({ reason: "unavailable" });
const expired = () => new ThreadSearchError({ reason: "cursor_expired" });
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const make = Effect.gen(function* () {
  const authority = yield* SearchAuthority.SearchAuthority;
  const index = yield* SearchIndex.SearchIndex;
  const threads = yield* ThreadDirectory.ThreadDirectory;
  const runQuery = yield* SearchQuery.make;
  const backfill = yield* Effect.serviceOption(SearchBackfill.SearchBackfill);
  const requireEnabled = Effect.gen(function* () {
    // Persist the disabled generation even when a query wakes the object first.
    const ready =
      Option.isNone(backfill) || (yield* backfill.value.ready.pipe(Effect.mapError(unavailable)));
    if (index.disabled || !ready) return yield* unavailable();
  });
  const queryItems: typeof runQuery = (actor, input, legacy) =>
    requireEnabled.pipe(Effect.andThen(runQuery(actor, input, legacy)));

  const search: ThreadSearch["Service"]["search"] = (actor, input) =>
    Effect.gen(function* () {
      const found = new Set<string>();
      const result: Array<OrchestrationSearchThreadsResult["matches"][number]> = [];
      let cursor: string | undefined;
      do {
        const page = yield* queryItems(
          actor,
          {
            query: input.query,
            mode: "literal",
            kinds: ["user", "assistant"],
            limit: 50,
            ...(cursor === undefined ? {} : { cursor }),
          },
          true,
        );
        if (!page.coverage.available) return yield* unavailable();
        for (const hit of page.hits) {
          if (found.has(hit.threadId) || (hit.kind !== "user" && hit.kind !== "assistant"))
            continue;
          found.add(hit.threadId);
          result.push({
            threadId: hit.threadId,
            projectId: hit.projectId,
            source: hit.kind,
            snippet: hit.snippet,
            messageCreatedAt: null,
            archived: hit.archived,
          });
          if (result.length >= (input.limit ?? 20)) return { matches: result };
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return { matches: result };
    });

  const searchOne: ThreadSearch["Service"]["searchOne"] = (actor, input) =>
    Effect.gen(function* () {
      const scope = yield* authority.current(actor);
      if (!scope.homes.some((home) => home.threadIds.includes(input.threadId)))
        return yield* unavailable();
      const result = yield* threads.forThread(input.threadId).find(scope.actor, input);
      const final = yield* authority.current(actor);
      if (
        !final.homes.some((home) => home.threadIds.includes(input.threadId)) ||
        encodeStrings(final.actor.contextIds) !== encodeStrings(scope.actor.contextIds)
      )
        return yield* expired();
      return { ...result, complete: true };
    }).pipe(
      Effect.catchTags({
        SearchIndexError: () => Effect.fail(unavailable()),
        ThreadObjectError: () => Effect.fail(unavailable()),
        ThreadNotFoundError: () => Effect.fail(unavailable()),
      }),
    );

  const readItem: ThreadSearch["Service"]["readItem"] = (actor, threadId, itemId) =>
    Effect.gen(function* () {
      const scope = yield* authority.current(actor);
      if (!scope.homes.some((home) => home.threadIds.includes(threadId))) return null;
      const record = yield* threads.forThread(threadId).searchDocuments(scope.actor, [itemId]);
      if (record === null || record.deleted) return null;
      const final = yield* authority.current(actor);
      if (
        !final.homes.some(
          (home) => home.home.projectId === record.projectId && home.threadIds.includes(threadId),
        ) ||
        encodeStrings(final.actor.contextIds) !== encodeStrings(scope.actor.contextIds)
      )
        return null;
      const item = record.documents.find((document) => document.itemId === itemId);
      return item === undefined
        ? null
        : {
            snapshotSequence: record.snapshotSequence,
            projectId: record.projectId,
            title: record.title,
            archived: record.archived,
            item,
          };
    }).pipe(Effect.mapError(() => unavailable()));

  return ThreadSearch.of({ query: queryItems, search, searchOne, readItem });
});

export const layer = Layer.effect(ThreadSearch, make);
