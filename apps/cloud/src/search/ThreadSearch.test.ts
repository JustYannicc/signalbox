import { ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as Platform from "../platform.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import { makeMemoryCloud } from "../testing.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as SearchAuthority from "./SearchAuthority.ts";
import * as SearchCursors from "./SearchCursors.ts";
import * as SearchIndex from "./SearchIndex.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import type { SearchCursor } from "./searchCursor.ts";

const actor: Actor = { userId: "user-1", contextIds: [PERSONAL_CONTEXT_ID] };
const projectId = ProjectId.make("project-1");
const home = { ownerId: actor.userId, projectId };
const memoryDirectory = makeMemoryCloud().threadDirectory;

type SearchIndexService = SearchIndex.SearchIndex["Service"];
type SearchQuery = Parameters<SearchIndexService["query"]>[0];
type SearchRecord = NonNullable<
  Effect.Success<ReturnType<ThreadDirectory.ThreadHandle["searchDocuments"]>>
>;

const scope = (threadIds: ReadonlyArray<string>, revision = 1): SearchAuthority.SearchScope => ({
  actor,
  revision,
  homes: threadIds.length === 0 ? [] : [{ home, threadIds }],
});

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

const candidate = (
  value: SearchIndex.SearchDocument,
  revision = 4,
): SearchIndex.SearchCandidate => ({
  ...value,
  title: `Title ${value.threadId}`,
  archived: false,
  revision,
  sourceSequence: revision,
});

const record = (
  threadId: string,
  documents: ReadonlyArray<SearchIndex.SearchDocument>,
  options: { readonly archived?: boolean; readonly snapshotSequence?: number } = {},
): SearchRecord => ({
  snapshotSequence: options.snapshotSequence ?? 9,
  projectId,
  title: `Current ${threadId}`,
  archived: options.archived ?? false,
  deleted: false,
  documents,
});

const page = (candidates: ReadonlyArray<SearchIndex.SearchCandidate>, hasMore = false) =>
  Effect.succeed({ candidates, hasMore });

const makeHarness = (options: {
  readonly scope?: SearchAuthority.SearchScope;
  readonly scopeAt?: (call: number) => SearchAuthority.SearchScope;
  readonly progress?: SearchIndexService["progress"];
  readonly query?: (input: SearchQuery) => ReturnType<SearchIndexService["query"]>;
  readonly records?: ReadonlyMap<string, SearchRecord>;
  readonly searchDocuments?: (
    threadId: string,
    actor: Actor,
    itemIds: ReadonlyArray<string>,
  ) => SearchRecord | null;
}) => {
  let authorityCalls = 0;
  const queries: Array<SearchQuery> = [];
  const reads: Array<{ readonly threadId: string; readonly itemIds: ReadonlyArray<string> }> = [];
  const storedCursors = new Map<string, SearchCursor>();
  let nextCursor = 0;
  const defaultScope = options.scope ?? scope([]);

  const authority: SearchAuthority.SearchAuthority["Service"] = {
    current: () =>
      Effect.sync(() => {
        authorityCalls += 1;
        return options.scopeAt?.(authorityCalls) ?? defaultScope;
      }),
  };

  const index: SearchIndexService = {
    deliver: () => Effect.void,
    progress:
      options.progress ??
      ((_home, threadIds) =>
        Effect.succeed(threadIds.map((threadId) => ({ threadId, revision: 4, complete: true })))),
    query: (input) => {
      queries.push(input);
      return options.query?.(input) ?? page([]);
    },
  };

  const cursors: SearchCursors.SearchCursors["Service"] = {
    read: (token) => Effect.succeed(storedCursors.get(token) ?? null),
    save: (value) =>
      Effect.sync(() => {
        const token = `cursor-${++nextCursor}`;
        storedCursors.set(token, value);
        return token;
      }),
  };

  const directory: ThreadDirectory.ThreadDirectory["Service"] = {
    forThread: (threadId) => {
      const handle = memoryDirectory.forThread(threadId);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "searchDocuments") {
            return (requestActor: Actor, itemIds: ReadonlyArray<string>) => {
              const id = String(threadId);
              reads.push({ threadId: id, itemIds });
              const found =
                options.searchDocuments?.(id, requestActor, itemIds) ??
                options.records?.get(id) ??
                null;
              return Effect.succeed(found);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };

  const layer = ThreadSearch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SearchAuthority.SearchAuthority, authority),
        Layer.succeed(SearchIndex.SearchIndex, index),
        Layer.succeed(SearchCursors.SearchCursors, cursors),
        Layer.succeed(ThreadDirectory.ThreadDirectory, directory),
        Platform.layerCrypto,
      ),
    ),
  );

  return { layer, queries, reads };
};

const withSearch = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  run: (search: ThreadSearch.ThreadSearch["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const search = yield* ThreadSearch.ThreadSearch;
    return yield* run(search);
  }).pipe(Effect.provide(harness.layer));

describe("ThreadSearch", () => {
  it.effect(
    "filters current access before the index limit, so a newer denied thread cannot starve an older allowed one",
    () => {
      const denied = candidate(
        document("thread-new-denied", "item-denied", "needle in denied thread"),
      );
      const allowed = candidate(
        document("thread-old-allowed", "item-allowed", "needle in allowed thread"),
      );
      const harness = makeHarness({
        scope: scope(["thread-old-allowed"]),
        records: new Map([["thread-old-allowed", record("thread-old-allowed", [allowed])]]),
        query: (input) => {
          const visible = [denied, allowed].filter((hit) => input.threadIds.includes(hit.threadId));
          return page(visible.slice(0, input.limit), visible.length > input.limit);
        },
      });

      return withSearch(harness, (search) =>
        search.query(actor, { query: "needle", limit: 1 }),
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.hits.map((hit) => hit.threadId)).toEqual([
              ThreadId.make("thread-old-allowed"),
            ]);
            expect(harness.queries[0]?.threadIds).toEqual(["thread-old-allowed"]);
          }),
        ),
      );
    },
  );

  it.effect(
    "discards a page when access is revoked between index lookup and the current record read",
    () => {
      const hit = candidate(document("thread-1", "item-1", "private needle snippet"));
      const harness = makeHarness({
        scopeAt: (call) => (call === 1 ? scope(["thread-1"], 1) : scope([], 2)),
        query: () => page([hit]),
      });

      return withSearch(harness, (search) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(search.query(actor, { query: "needle" }));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
          expect(harness.reads).toEqual([]);
        }),
      );
    },
  );

  it.effect("rejects a cursor after the authorized search scope changes", () => {
    let current = scope(["thread-1"], 1);
    const hit = candidate(document("thread-1", "item-1", "needle"));
    const harness = makeHarness({
      scopeAt: () => current,
      records: new Map([["thread-1", record("thread-1", [hit])]]),
      query: () => page([hit], true),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const first = yield* search.query(actor, { query: "needle", limit: 1 });
        expect(first.nextCursor).not.toBeNull();
        if (first.nextCursor === null) throw new Error("Expected a cursor.");
        current = scope(["thread-1"], 2);
        const result = yield* Effect.result(
          search.query(actor, {
            query: "needle",
            limit: 1,
            cursor: first.nextCursor,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
        expect(harness.queries).toHaveLength(1);
      }),
    );
  });

  it.effect("labels a hit from the current thread record as archived", () => {
    const hit = candidate(document("thread-archived", "item-1", "needle"));
    const harness = makeHarness({
      scope: scope(["thread-archived"]),
      records: new Map([["thread-archived", record("thread-archived", [hit], { archived: true })]]),
      query: () => page([hit]),
    });

    return withSearch(harness, (search) => search.query(actor, { query: "needle" })).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.hits[0]?.archived).toBe(true))),
    );
  });

  it.effect("reports partial backfill coverage even when the index can answer", () => {
    const harness = makeHarness({
      scope: scope(["thread-ready", "thread-pending"]),
      progress: (_home, threadIds) =>
        Effect.succeed([{ threadId: threadIds[0]!, revision: 4, complete: true }]),
    });

    return withSearch(harness, (search) => search.query(actor, { query: "needle" })).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result.coverage).toEqual({
            complete: false,
            indexedThreads: 1,
            pendingThreads: 1,
            available: true,
          }),
        ),
      ),
    );
  });

  it.effect(
    "reports unavailable index coverage and counts affected authorized threads as pending",
    () => {
      const harness = makeHarness({
        scope: scope(["thread-1", "thread-2"]),
        progress: () =>
          Effect.fail(
            new SearchIndex.SearchIndexError({
              operation: "progress",
              cause: new Error("index offline"),
            }),
          ),
      });

      return withSearch(harness, (search) => search.query(actor, { query: "needle" })).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            expect(result.coverage).toEqual({
              complete: false,
              indexedThreads: 0,
              pendingThreads: 2,
              available: false,
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "reads only the requested item after checking the thread is currently authorized",
    () => {
      const requested = document("thread-1", "item-requested", "matching item");
      const other = document("thread-1", "item-other", "other item");
      const harness = makeHarness({
        scope: scope(["thread-1"]),
        records: new Map([["thread-1", record("thread-1", [requested, other])]]),
      });

      return withSearch(harness, (search) =>
        Effect.gen(function* () {
          const result = yield* search.readItem(actor, ThreadId.make("thread-1"), requested.itemId);
          expect(result?.item.itemId).toBe(requested.itemId);
          expect(harness.reads).toEqual([{ threadId: "thread-1", itemIds: [requested.itemId] }]);
        }),
      );
    },
  );

  it.effect("does not read an exact item when the caller lacks current thread access", () => {
    const harness = makeHarness({ scope: scope([]) });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const result = yield* search.readItem(actor, ThreadId.make("thread-denied"), "item-1");
        expect(result).toBeNull();
        expect(harness.reads).toEqual([]);
      }),
    );
  });

  it.effect("keeps the legacy thread-search call on literal substring matching", () => {
    const exact = candidate(document("thread-exact", "item-exact", "cat dog appears together"));
    const separate = candidate(document("thread-separate", "item-separate", "cat then dog"));
    const harness = makeHarness({
      scope: scope(["thread-exact", "thread-separate"]),
      records: new Map([
        ["thread-exact", record("thread-exact", [exact])],
        ["thread-separate", record("thread-separate", [separate])],
      ]),
      query: () => page([exact, separate]),
    });

    return withSearch(harness, (search) => search.search(actor, { query: "cat dog" })).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(harness.queries[0]?.mode).toBe("literal");
          expect(result.matches.map((match) => match.threadId)).toEqual([
            ThreadId.make("thread-exact"),
          ]);
        }),
      ),
    );
  });
});
