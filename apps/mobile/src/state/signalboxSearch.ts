/**
 * Content search through the Signalbox search service (`signalbox.search.query`),
 * for environments that serve folders. Pages accumulate per environment so
 * "More results" extends the list instead of replacing it.
 */
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import {
  SIGNALBOX_SEARCH_WS_METHODS,
  type ThreadSearchResult,
} from "@t3tools/contracts/signalboxSearch";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useDebouncedValue } from "./queries";
import { environmentServerConfigsAtom } from "./server";
import { signalboxContexts } from "./signalboxContexts";
import { signalboxFolders } from "./signalboxFolders";
import {
  classifySearchFailure,
  summarizeSearchCoverage,
  type EnvironmentSearchHit,
  type SearchCoverageSummary,
  type SearchFailure,
} from "@t3tools/client-runtime/state/signalboxSearchModel";

const SEARCH_PAGE_SIZE = 25;
export const MIN_CONTENT_SEARCH_LENGTH = 2;

/**
 * Changes whenever who can see what might have: the environment's folders
 * (homes, sharing) or its owners (memberships). A search on screen re-runs.
 */
const searchAccessSignal = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const input = { environmentId, input: {} };
    const folders = Option.getOrNull(AsyncResult.value(get(signalboxFolders.snapshot(input))));
    const owners = Option.getOrNull(AsyncResult.value(get(signalboxContexts.snapshot(input))));
    const previous = Option.getOrUndefined(get.self<readonly [unknown, unknown]>());
    return previous !== undefined && previous[0] === folders && previous[1] === owners
      ? previous
      : ([folders, owners] as const);
  }).pipe(Atom.withLabel(`signalbox:search:access:${environmentId}`)),
);

// Access can be revoked between searches, so a search is never served from
// cache: no stale window and no idle retention. Session changes re-run it in
// the query runtime already.
export const signalboxSearchQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "signalbox:search:query",
  tag: SIGNALBOX_SEARCH_WS_METHODS.query,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId }) => searchAccessSignal(environmentId),
});

const SearchPagesKey = Schema.fromJsonString(
  Schema.Struct({
    query: Schema.String,
    targets: Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, cursors: Schema.Array(Schema.String) }),
    ),
  }),
);
type SearchPagesKey = typeof SearchPagesKey.Type;
const decodeSearchPagesKey = Schema.decodeUnknownOption(SearchPagesKey);
const encodeSearchPagesKey = Schema.encodeSync(SearchPagesKey);

function pageAtoms(key: SearchPagesKey) {
  return key.targets.flatMap(({ environmentId, cursors }) =>
    [null, ...cursors].map((cursor) => ({
      environmentId,
      atom: signalboxSearchQuery({
        environmentId,
        input: {
          query: key.query,
          limit: SEARCH_PAGE_SIZE,
          distinctThreads: true,
          ...(cursor === null ? {} : { cursor }),
        },
      }),
    })),
  );
}

export interface ContentSearchState {
  readonly hits: ReadonlyArray<EnvironmentSearchHit>;
  readonly isLoading: boolean;
  /** The first failure, once nothing is still loading for that environment. */
  readonly failure: SearchFailure | null;
  readonly coverage: SearchCoverageSummary | null;
  /** Each environment's cursor for its next page, when it has one. */
  readonly nextCursors: ReadonlyMap<EnvironmentId, string>;
}

const EMPTY_STATE: ContentSearchState = {
  hits: [],
  isLoading: false,
  failure: null,
  coverage: null,
  nextCursors: new Map(),
};

const searchPagesAtom = Atom.family((key: string) =>
  Atom.make((get): ContentSearchState => {
    const decoded = decodeSearchPagesKey(key);
    if (Option.isNone(decoded)) return EMPTY_STATE;
    const hits: Array<EnvironmentSearchHit> = [];
    const latestPages = new Map<EnvironmentId, ThreadSearchResult>();
    const stopped = new Set<EnvironmentId>();
    let isLoading = false;
    let failure: SearchFailure | null = null;
    for (const { environmentId, atom } of pageAtoms(decoded.value)) {
      // A failed page ends that environment's list; later pages hang off its cursor.
      if (stopped.has(environmentId)) continue;
      const result = get(atom);
      isLoading ||= result.waiting;
      // A refreshed page may still carry its previous value after access changed.
      if (result.waiting) {
        stopped.add(environmentId);
        continue;
      }
      if (result._tag === "Failure" && !result.waiting) {
        failure ??= classifySearchFailure(Option.getOrNull(Cause.findErrorOption(result.cause)));
        stopped.add(environmentId);
        continue;
      }
      const page = Option.getOrNull(AsyncResult.value(result));
      if (page === null) {
        stopped.add(environmentId);
        continue;
      }
      latestPages.set(environmentId, page);
      for (const hit of page.hits) hits.push({ environmentId, hit });
    }
    const nextCursors = new Map<EnvironmentId, string>();
    for (const [environmentId, page] of latestPages) {
      if (!stopped.has(environmentId) && page.nextCursor !== null) {
        nextCursors.set(environmentId, page.nextCursor);
      }
    }
    return {
      hits,
      isLoading,
      failure,
      coverage: summarizeSearchCoverage([...latestPages.values()]),
      nextCursors,
    };
  }).pipe(Atom.withLabel("signalbox:search:pages")),
);

const EMPTY_SEARCH_ATOM = Atom.make(EMPTY_STATE).pipe(Atom.withLabel("signalbox:search:empty"));

const retrySearchPages = Atom.fn((key: string, get) =>
  Effect.sync(() => {
    const decoded = decodeSearchPagesKey(key);
    if (Option.isNone(decoded)) return;
    for (const { atom } of pageAtoms(decoded.value)) get.refresh(atom);
  }),
).pipe(Atom.withLabel("signalbox:search:retry"));

const contentSearchEnvironmentIdsAtom = Atom.make((get) => {
  const ids = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.threadContentSearch === true)
    .map(([environmentId]) => environmentId)
    .sort();
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== undefined &&
    previous.length === ids.length &&
    previous.every((id, index) => id === ids[index])
    ? previous
    : ids;
}).pipe(Atom.withLabel("signalbox:search:environments"));

/** Environments whose threads the search service answers for. */
export function useContentSearchEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(contentSearchEnvironmentIdsAtom);
}

export interface ContentSearchView extends ContentSearchState {
  /** False where no connected environment serves the search service. */
  readonly supported: boolean;
  /** Typing ahead of the debounce or a page in flight. */
  readonly isPending: boolean;
  readonly canLoadMore: boolean;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

export function useContentSearch(rawQuery: string): ContentSearchView {
  const environmentIds = useContentSearchEnvironmentIds();
  const query = rawQuery.trim();
  const debouncedQuery = useDebouncedValue(query, 150);
  const canSearch = environmentIds.length > 0 && query.length >= MIN_CONTENT_SEARCH_LENGTH;
  const settledQuery = canSearch && query === debouncedQuery ? debouncedQuery : null;
  // Extra pages belong to one query; a new query starts from its first page.
  const [extraPages, setExtraPages] = useState<{
    readonly query: string | null;
    readonly cursors: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
  }>({ query: null, cursors: new Map() });
  const cursors = extraPages.query === settledQuery ? extraPages.cursors : null;
  const key = useMemo(
    () =>
      settledQuery === null
        ? null
        : encodeSearchPagesKey({
            query: settledQuery,
            targets: environmentIds.map((environmentId) => ({
              environmentId,
              cursors: [...(cursors?.get(environmentId) ?? [])],
            })),
          }),
    [cursors, environmentIds, settledQuery],
  );
  const state = useAtomValue(key === null ? EMPTY_SEARCH_ATOM : searchPagesAtom(key));
  const retryPages = useAtomSet(retrySearchPages);
  const loadMore = useCallback(() => {
    if (settledQuery === null || state.nextCursors.size === 0) return;
    setExtraPages((previous) => {
      const base = previous.query === settledQuery ? previous.cursors : new Map();
      const next = new Map(base);
      for (const [environmentId, cursor] of state.nextCursors) {
        const existing = next.get(environmentId) ?? [];
        if (!existing.includes(cursor)) next.set(environmentId, [...existing, cursor]);
      }
      return { query: settledQuery, cursors: next };
    });
  }, [settledQuery, state.nextCursors]);
  const retry = useCallback(() => {
    if (key === null) return;
    // An expired cursor can't be retried; search again from the first page.
    if (state.failure === "expired") {
      setExtraPages({ query: null, cursors: new Map() });
    }
    retryPages(key);
  }, [key, retryPages, state.failure]);

  return {
    ...(key === null ? EMPTY_STATE : state),
    supported: environmentIds.length > 0,
    isPending: canSearch && (query !== debouncedQuery || state.isLoading),
    canLoadMore: key !== null && !state.isLoading && state.nextCursors.size > 0,
    loadMore,
    retry,
  };
}
