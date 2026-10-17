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
import * as SearchBackfill from "./SearchBackfill.ts";
import * as SearchCursors from "./SearchCursors.ts";
import * as SearchIndex from "./SearchIndex.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import type { SearchCursor } from "./searchCursor.ts";

const actor: SearchAuthority.SearchActor = { userId: "user-1", contextIds: [PERSONAL_CONTEXT_ID] };
const projectId = ProjectId.make("project-1");
const home = { ownerId: actor.userId, projectId };
const secondHome = { ownerId: "owner-2", projectId: ProjectId.make("project-2") };
const memoryDirectory = makeMemoryCloud().threadDirectory;

type SearchIndexService = SearchIndex.SearchIndex["Service"];
type SearchQuery = Parameters<SearchIndexService["query"]>[0];
type SearchActor = SearchAuthority.SearchActor;
type FindInput = Parameters<ThreadDirectory.ThreadHandle["find"]>[1];
type FindEffect = ReturnType<ThreadDirectory.ThreadHandle["find"]>;
type SearchRecord = NonNullable<
  Effect.Success<ReturnType<ThreadDirectory.ThreadHandle["searchDocuments"]>>
>;

const scopeForHomes = (
  homes: ReadonlyArray<{
    readonly home: SearchIndex.SearchHome;
    readonly threadIds: ReadonlyArray<string>;
  }>,
  currentActor: SearchAuthority.SearchActor = actor,
  revision = 1,
  grants: ReadonlyArray<SearchIndex.SearchHome> = homes.map(({ home: currentHome }) => currentHome),
): SearchAuthority.SearchScope => ({ actor: currentActor, revision, homes, grants });

const scope = (
  threadIds: ReadonlyArray<string>,
  revision = 1,
  currentActor: SearchAuthority.SearchActor = actor,
  grants: ReadonlyArray<SearchIndex.SearchHome> = threadIds.length === 0 ? [] : [home],
): SearchAuthority.SearchScope =>
  scopeForHomes(
    threadIds.length === 0 ? [] : [{ home, threadIds }],
    currentActor,
    revision,
    grants,
  );

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
  ordering: { readonly matchRank?: number; readonly threadUpdatedAt?: string } = {},
): SearchIndex.SearchCandidate & SearchIndex.SearchDocument => ({
  ...value,
  title: `Title ${value.threadId}`,
  archived: false,
  revision,
  sourceSequence: revision,
  matchRank: ordering.matchRank ?? 1,
  threadUpdatedAt: ordering.threadUpdatedAt ?? "2026-10-17T10:00:00.000Z",
});

const record = (
  threadId: string,
  documents: ReadonlyArray<SearchIndex.SearchDocument>,
  options: {
    readonly archived?: boolean;
    readonly snapshotSequence?: number;
    readonly projectId?: ProjectId;
  } = {},
): SearchRecord => ({
  snapshotSequence: options.snapshotSequence ?? 9,
  projectId: options.projectId ?? projectId,
  title: `Current ${threadId}`,
  archived: options.archived ?? false,
  deleted: false,
  documents,
});

const page = (candidates: ReadonlyArray<SearchIndex.SearchCandidate>, hasMore = false) =>
  Effect.succeed({ candidates, hasMore });

const sortKey = (value: SearchIndex.SearchCandidate): SearchIndex.SearchSortKey => ({
  matchRank: value.matchRank,
  threadUpdatedAt: value.threadUpdatedAt,
  threadId: value.threadId,
  itemId: value.itemId,
});

const compareString = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const compareSortKey = (left: SearchIndex.SearchSortKey, right: SearchIndex.SearchSortKey) =>
  left.matchRank - right.matchRank ||
  compareString(right.threadUpdatedAt, left.threadUpdatedAt) ||
  compareString(left.threadId, right.threadId) ||
  compareString(left.itemId, right.itemId);

const queryCandidates = (
  candidates: ReadonlyArray<SearchIndex.SearchCandidate>,
  input: SearchQuery,
) => {
  const ordered = candidates
    .filter((value) => input.threadIds.includes(value.threadId))
    .toSorted((left, right) => compareSortKey(sortKey(left), sortKey(right)));
  const distinct = input.distinctThreads
    ? ordered.filter(
        (value, index, values) =>
          values.findIndex((candidate) => candidate.threadId === value.threadId) === index,
      )
    : ordered;
  const selected = distinct.filter(
    (value) => input.after === null || compareSortKey(sortKey(value), input.after) > 0,
  );
  return page(selected.slice(0, input.limit), selected.length > input.limit);
};

const makeHarness = (options: {
  readonly generation?: () => string;
  readonly disabled?: boolean;
  readonly backfillReady?: () => boolean;
  readonly scope?: SearchAuthority.SearchScope;
  readonly scopeAt?: (call: number, actor: SearchActor) => SearchAuthority.SearchScope;
  readonly progress?: SearchIndexService["progress"];
  readonly query?: (input: SearchQuery) => ReturnType<SearchIndexService["query"]>;
  readonly records?: ReadonlyMap<string, SearchRecord>;
  readonly find?: (threadId: string, actor: Actor, input: FindInput) => FindEffect;
  readonly searchDocuments?: (
    threadId: string,
    actor: Actor,
    itemIds: ReadonlyArray<string>,
  ) => SearchRecord | null;
}) => {
  let authorityCalls = 0;
  const queries: Array<SearchQuery> = [];
  const authorityActors: Array<SearchActor> = [];
  const reads: Array<{ readonly threadId: string; readonly itemIds: ReadonlyArray<string> }> = [];
  const finds: Array<string> = [];
  const readyChecks: Array<boolean> = [];
  const storedCursors = new Map<string, SearchCursor>();
  let nextCursor = 0;
  const seenThreads = new Map<string, Map<string, number>>();
  const defaultScope = options.scope ?? scope([]);

  const authority: SearchAuthority.SearchAuthority["Service"] = {
    current: (requestActor) =>
      Effect.sync(() => {
        authorityCalls += 1;
        authorityActors.push(requestActor);
        return options.scopeAt?.(authorityCalls, requestActor) ?? defaultScope;
      }),
  };

  const index: SearchIndexService = {
    get generation() {
      return options.generation?.() ?? "search-generation-1";
    },
    disabled: options.disabled ?? false,
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
    seen: (cursor) =>
      Effect.succeed(
        [...(seenThreads.get(cursor.session) ?? [])]
          .filter(([, page]) => page <= cursor.page)
          .map(([threadId]) => threadId),
      ),
    save: (value, previous, emitted = []) =>
      Effect.sync(() => {
        const token = `cursor-${++nextCursor}`;
        const session = previous?.session ?? token;
        const page = (previous?.page ?? 0) + 1;
        const seen = seenThreads.get(session) ?? new Map<string, number>();
        for (const threadId of emitted)
          seen.set(threadId, Math.min(seen.get(threadId) ?? page, page));
        seenThreads.set(session, seen);
        storedCursors.set(token, { ...value, session, page });
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
          if (property === "find") {
            return (requestActor: Actor, input: FindInput) => {
              const id = String(threadId);
              finds.push(id);
              return (
                options.find?.(id, requestActor, input) ??
                Effect.succeed({
                  snapshotSequence: 0,
                  totalMatches: 0,
                  activeIndex: 0,
                  navigation: [],
                  match: null,
                })
              );
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };

  const services = Layer.mergeAll(
    Layer.succeed(SearchAuthority.SearchAuthority, authority),
    Layer.succeed(SearchIndex.SearchIndex, index),
    Layer.succeed(SearchCursors.SearchCursors, cursors),
    Layer.succeed(ThreadDirectory.ThreadDirectory, directory),
    Platform.layerCrypto,
  );
  const dependencies =
    options.backfillReady === undefined
      ? services
      : Layer.merge(
          services,
          Layer.succeed(SearchBackfill.SearchBackfill, {
            ready: Effect.sync(() => {
              const ready = options.backfillReady!();
              readyChecks.push(ready);
              return ready;
            }),
            step: Effect.void,
          }),
        );
  const layer = ThreadSearch.layer.pipe(Layer.provide(dependencies));

  return {
    layer,
    queries,
    reads,
    finds,
    readyChecks,
    authorityActors,
    cursorFor: (token: string) => storedCursors.get(token),
  };
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
    "discards the page and coverage when an authoritative grant is revoked during lookup",
    () => {
      const hit = candidate(document("thread-1", "item-1", "private needle snippet"));
      const harness = makeHarness({
        scopeAt: (call, requestActor) =>
          call === 1
            ? scope(["thread-1"], 1, requestActor, [home])
            : scopeForHomes([], requestActor, 2, []),
        query: () => page([hit]),
      });

      return withSearch(harness, (search) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(search.query(actor, { query: "needle" }));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
          expect(harness.reads).toEqual([]);
          expect(harness.queries).toHaveLength(1);
        }),
      );
    },
  );

  it.effect("rejects a cursor after an authoritative drive grant changes", () => {
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
        current = scopeForHomes([{ home, threadIds: ["thread-1"] }], actor, 2, []);
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

  it.effect("keeps every search entry point unavailable when search is disabled", () => {
    const harness = makeHarness({ disabled: true, scope: scope(["thread-1"]) });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const results = [
          yield* Effect.result(search.query(actor, { query: "needle" })),
          yield* Effect.result(search.search(actor, { query: "needle" })),
          yield* Effect.result(
            search.searchOne(actor, { threadId: ThreadId.make("thread-1"), query: "needle" }),
          ),
          yield* Effect.result(search.readItem(actor, ThreadId.make("thread-1"), "item-1")),
        ];
        for (const result of results) {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure.reason).toBe("unavailable");
        }
        expect(harness.queries).toEqual([]);
        expect(harness.reads).toEqual([]);
        expect(harness.finds).toEqual([]);
        expect(harness.authorityActors).toEqual([]);
      }),
    );
  });

  it.effect("gates every entry point on the optional backfill-ready service", () => {
    const harness = makeHarness({
      scope: scope(["thread-1"]),
      backfillReady: () => false,
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const results = [
          yield* Effect.result(search.query(actor, { query: "needle" })),
          yield* Effect.result(search.search(actor, { query: "needle" })),
          yield* Effect.result(
            search.searchOne(actor, { threadId: ThreadId.make("thread-1"), query: "needle" }),
          ),
          yield* Effect.result(search.readItem(actor, ThreadId.make("thread-1"), "item-1")),
        ];
        for (const result of results) {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure.reason).toBe("unavailable");
        }
        expect(harness.readyChecks).toEqual([false, false, false, false]);
        expect(harness.queries).toEqual([]);
        expect(harness.reads).toEqual([]);
        expect(harness.finds).toEqual([]);
        expect(harness.authorityActors).toEqual([]);
      }),
    );
  });

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

  it.effect("keeps a cursor when unrelated thread-index rows change inside the same grant", () => {
    let currentThreadIds = ["thread-1", "thread-2"];
    let queryCall = 0;
    const first = candidate(document("thread-1", "item-1", "needle first"));
    const next = candidate(document("thread-3", "item-3", "needle next"));
    const harness = makeHarness({
      scopeAt: (_call, currentActor) => scope(currentThreadIds, 1, currentActor, [home]),
      records: new Map([
        ["thread-1", record("thread-1", [first])],
        ["thread-3", record("thread-3", [next])],
      ]),
      query: () => {
        const value = queryCall++ === 0 ? first : next;
        return page([value], queryCall === 1);
      },
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const initial = yield* search.query(actor, { query: "needle", limit: 1 });
        expect(initial.nextCursor).not.toBeNull();

        // One unrelated thread disappeared and another appeared; the grant is unchanged.
        currentThreadIds = ["thread-1", "thread-3"];
        const nextPage = yield* search.query(actor, {
          query: "needle",
          limit: 1,
          cursor: initial.nextCursor!,
        });
        expect(nextPage.hits.map((hit) => hit.threadId)).toEqual([ThreadId.make("thread-3")]);
        expect(harness.queries).toHaveLength(2);
      }),
    );
  });

  it.effect("persists the v2 global sort key without binding a cursor to one home", () => {
    const hit = candidate(document("thread-1", "item-1", "needle"));
    const harness = makeHarness({
      scope: scope(["thread-1"]),
      records: new Map([["thread-1", record("thread-1", [hit])]]),
      query: () => page([hit], true),
    });

    return withSearch(harness, (search) => search.query(actor, { query: "needle", limit: 1 })).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.nextCursor).not.toBeNull();
          if (result.nextCursor === null) throw new Error("Expected a cursor.");
          expect(harness.cursorFor(result.nextCursor)).toEqual({
            version: 2,
            session: expect.any(String),
            page: 1,
            fingerprint: expect.any(String),
            after: sortKey(hit),
          });
        }),
      ),
    );
  });

  it.effect("expires a cursor when the represented project bound changes", () => {
    const represented = (projects: ReadonlyArray<string>): SearchActor => ({
      ...actor,
      projectIds: projects,
    });
    const firstActor = represented([projectId]);
    const nextActor = represented([secondHome.projectId]);
    const first = candidate(document("thread-1", "item-1", "needle first"));
    const second = candidate(document("thread-1", "item-2", "needle second"));
    const harness = makeHarness({
      scopeAt: (_call, requestActor) => scope(["thread-1"], 1, requestActor, [home]),
      records: new Map([["thread-1", record("thread-1", [first, second])]]),
      query: (input) => queryCandidates([first, second], input),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const initial = yield* search.query(firstActor, { query: "needle", limit: 1 });
        expect(initial.nextCursor).not.toBeNull();
        const result = yield* Effect.result(
          search.query(nextActor, {
            query: "needle",
            limit: 1,
            cursor: initial.nextCursor!,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
        expect(harness.queries).toHaveLength(1);
        expect(harness.authorityActors.at(-1)?.projectIds).toEqual([secondHome.projectId]);
      }),
    );
  });

  it.effect("expires a cursor when the search index generation changes", () => {
    let generation = "search-generation-1";
    const first = candidate(document("thread-1", "item-1", "needle first"));
    const second = candidate(document("thread-1", "item-2", "needle second"));
    const harness = makeHarness({
      generation: () => generation,
      scope: scope(["thread-1"]),
      records: new Map([["thread-1", record("thread-1", [first, second])]]),
      query: (input) => queryCandidates([first, second], input),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const initial = yield* search.query(actor, { query: "needle", limit: 1 });
        expect(initial.nextCursor).not.toBeNull();
        generation = "search-generation-2";
        const result = yield* Effect.result(
          search.query(actor, {
            query: "needle",
            limit: 1,
            cursor: initial.nextCursor!,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
        expect(harness.queries).toHaveLength(1);
      }),
    );
  });

  it.effect("expires a cursor when query options change", () => {
    const first = candidate(document("thread-1", "item-1", "needle first"));
    const second = candidate(document("thread-1", "item-2", "needle second"));
    const harness = makeHarness({
      scope: scope(["thread-1"]),
      records: new Map([["thread-1", record("thread-1", [first, second])]]),
      query: (input) => queryCandidates([first, second], input),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const initial = yield* search.query(actor, { query: "needle", limit: 1 });
        expect(initial.nextCursor).not.toBeNull();
        const result = yield* Effect.result(
          search.query(actor, {
            query: "needle",
            limit: 2,
            cursor: initial.nextCursor!,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
        expect(harness.queries).toHaveLength(1);
      }),
    );
  });

  it.effect("continues to a later home after exactly 500 stale candidates", () => {
    const stale = Array.from({ length: 500 }, (_, index) =>
      candidate(
        document("thread-a", `item-${String(index).padStart(3, "0")}`, `needle stale ${index}`),
      ),
    );
    const live = candidate(document("thread-z", "item-live", "needle current result"), 4);
    const harness = makeHarness({
      scope: scopeForHomes(
        [
          { home, threadIds: ["thread-a"] },
          { home: secondHome, threadIds: ["thread-z"] },
        ],
        actor,
        1,
        [home, secondHome],
      ),
      searchDocuments: (threadId) =>
        threadId === "thread-a"
          ? record(threadId, [])
          : record(threadId, [live], { projectId: secondHome.projectId }),
      query: (input) => queryCandidates(input.home.projectId === projectId ? stale : [live], input),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const firstPage = yield* search.query(actor, { query: "needle", limit: 1 });
        expect(firstPage.hits).toEqual([]);
        expect(firstPage.nextCursor).not.toBeNull();

        const secondPage = yield* search.query(actor, {
          query: "needle",
          limit: 1,
          cursor: firstPage.nextCursor!,
        });
        expect(secondPage.hits.map((hit) => hit.threadId)).toEqual([ThreadId.make("thread-z")]);
      }),
    );
  });

  it.effect("merges rich-ranked results globally before timestamp and ID tie breaks", () => {
    const title = candidate(document("thread-title", "item-title", "needle title", "thread"), 4, {
      matchRank: 0,
      threadUpdatedAt: "2026-10-17T08:00:00.000Z",
    });
    const userAFirst = candidate(document("thread-a", "item-a", "needle user a"), 4, {
      matchRank: 1,
      threadUpdatedAt: "2026-10-17T10:00:00.000Z",
    });
    const userALast = candidate(document("thread-a", "item-z", "needle user z"), 4, {
      matchRank: 1,
      threadUpdatedAt: "2026-10-17T10:00:00.000Z",
    });
    const userB = candidate(document("thread-b", "item-b", "needle user b"), 4, {
      matchRank: 1,
      threadUpdatedAt: "2026-10-17T10:00:00.000Z",
    });
    const userOlder = candidate(
      document("thread-user-older", "item-older", "needle older user"),
      4,
      { matchRank: 1, threadUpdatedAt: "2026-10-17T09:00:00.000Z" },
    );
    const assistant = candidate(
      document("thread-assistant", "item-assistant", "needle newest assistant", "assistant"),
      4,
      { matchRank: 2, threadUpdatedAt: "2026-10-17T12:00:00.000Z" },
    );
    const candidates = [title, userAFirst, userALast, userB, userOlder, assistant];
    const harness = makeHarness({
      scope: scopeForHomes(
        [
          { home, threadIds: ["thread-title", "thread-a", "thread-user-older"] },
          { home: secondHome, threadIds: ["thread-b", "thread-assistant"] },
        ],
        actor,
        1,
        [home, secondHome],
      ),
      records: new Map([
        ["thread-title", record("thread-title", [title])],
        ["thread-a", record("thread-a", [userAFirst, userALast])],
        ["thread-b", record("thread-b", [userB], { projectId: secondHome.projectId })],
        ["thread-user-older", record("thread-user-older", [userOlder])],
        [
          "thread-assistant",
          record("thread-assistant", [assistant], { projectId: secondHome.projectId }),
        ],
      ]),
      query: (input) => queryCandidates(candidates, input),
    });

    return withSearch(harness, (search) => search.query(actor, { query: "needle", limit: 6 })).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.hits.map((hit) => `${hit.threadId}:${hit.itemId}`)).toEqual([
            "thread-title:item-title",
            "thread-a:item-a",
            "thread-a:item-z",
            "thread-b:item-b",
            "thread-user-older:item-older",
            "thread-assistant:item-assistant",
          ]);
          expect(harness.queries.every((query) => query.order === "rich")).toBe(true);
        }),
      ),
    );
  });

  it.effect("keeps item search multi-hit while Home search deduplicates threads", () => {
    const first = candidate(document("thread-1", "item-1", "needle first", "user"));
    const second = candidate(document("thread-1", "item-2", "needle second", "assistant"));
    const harness = makeHarness({
      scope: scope(["thread-1"]),
      records: new Map([["thread-1", record("thread-1", [first, second])]]),
      query: (input) => queryCandidates([first, second], input),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const itemResults = yield* search.query(actor, { query: "needle", limit: 2 });
        expect(itemResults.hits.map((hit) => hit.itemId)).toEqual(["item-1", "item-2"]);

        const homePage = yield* search.query(actor, {
          query: "needle",
          limit: 2,
          distinctThreads: true,
        });
        expect(homePage.hits).toHaveLength(1);

        const homeResults = yield* search.search(actor, { query: "needle", limit: 2 });
        expect(homeResults.matches).toHaveLength(1);
        expect(homeResults.matches[0]?.threadId).toBe(ThreadId.make("thread-1"));
      }),
    );
  });

  it.effect(
    "finds a current lower-ranked item when the indexed winner is stale, without repeating the thread",
    () => {
      const stale = candidate(document("thread-a", "old-title", "needle old title", "thread"), 4, {
        matchRank: 0,
      });
      const current = candidate(
        document("thread-a", "current-message", "needle current", "user"),
        4,
        { matchRank: 1 },
      );
      const other = candidate(
        document("thread-b", "other-message", "needle other", "assistant"),
        4,
        { matchRank: 2 },
      );
      const harness = makeHarness({
        scope: scope(["thread-a", "thread-b"]),
        records: new Map([
          ["thread-a", record("thread-a", [current])],
          ["thread-b", record("thread-b", [other])],
        ]),
        query: (input) => queryCandidates([stale, current, other], input),
      });
      return withSearch(harness, (search) =>
        Effect.gen(function* () {
          const input = { query: "needle", distinctThreads: true, limit: 1 };
          const first = yield* search.query(actor, input);
          expect(first.hits.map((hit) => hit.itemId)).toEqual(["current-message"]);
          expect(first.nextCursor).not.toBeNull();
          const second = yield* search.query(actor, { ...input, cursor: first.nextCursor! });
          expect(second.hits.map((hit) => hit.threadId)).toEqual([ThreadId.make("thread-b")]);
          expect(second.nextCursor).toBeNull();
        }),
      );
    },
  );

  it.effect("retains legacy user-first ordering and updated-time tie breaks", () => {
    const userRecent = candidate(
      document("thread-user-recent", "item-user-recent", "needle user recent", "user"),
      4,
      { matchRank: 0, threadUpdatedAt: "2026-10-17T10:00:00.000Z" },
    );
    const userOlder = candidate(
      document("thread-user-older", "item-user-older", "needle user older", "user"),
      4,
      { matchRank: 0, threadUpdatedAt: "2026-10-17T08:00:00.000Z" },
    );
    const assistantNewest = candidate(
      document("thread-assistant", "item-assistant", "needle assistant", "assistant"),
      4,
      { matchRank: 1, threadUpdatedAt: "2026-10-17T11:00:00.000Z" },
    );
    const candidates = [userRecent, userOlder, assistantNewest];
    const harness = makeHarness({
      scope: scope(candidates.map(({ threadId }) => threadId)),
      records: new Map(candidates.map((item) => [item.threadId, record(item.threadId, [item])])),
      query: (input) => queryCandidates(candidates, input),
    });

    return withSearch(harness, (search) =>
      search.search(actor, { query: "needle", limit: 3 }),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(harness.queries[0]?.order).toBe("legacy");
          expect(result.matches.map((match) => match.threadId)).toEqual([
            ThreadId.make("thread-user-recent"),
            ThreadId.make("thread-user-older"),
            ThreadId.make("thread-assistant"),
          ]);
        }),
      ),
    );
  });

  it.effect("preserves cursor_expired from its own in-thread Find recheck", () => {
    const harness = makeHarness({
      scopeAt: (call, requestActor) =>
        call === 1
          ? scope(["thread-1"], 1, requestActor, [home])
          : scope(["thread-1"], 2, { ...requestActor, contextIds: [] }, [home]),
    });

    return withSearch(harness, (search) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          search.searchOne(actor, { threadId: ThreadId.make("thread-1"), query: "needle" }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("cursor_expired");
      }),
    );
  });
});
