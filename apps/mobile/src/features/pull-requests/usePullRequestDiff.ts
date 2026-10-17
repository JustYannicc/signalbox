import {
  EnvironmentId,
  ProjectId,
  type PullRequestDiffResult,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import { useAtomRefresh } from "@effect/atom-react";
import { useCallback, useMemo, useState } from "react";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import type { ReviewParsedDiff } from "../review/reviewModel";
import {
  combinePullRequestDiffPages,
  retainPullRequestDiffPage,
  type PullRequestDiffPage,
} from "./pullRequestDiffPages";

export type PullRequestParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
  readonly initialSummary?: PullRequestListEntry;
};

export type PullRequestDiffParams = PullRequestParams & { readonly commit?: string };

export function pullRequestTarget(params: PullRequestParams) {
  return {
    environmentId: EnvironmentId.make(params.environmentId),
    input: {
      projectId: ProjectId.make(params.projectId),
      repository: params.repository,
      number: params.number,
      ...(params.host ? { host: params.host } : {}),
    },
  };
}

const NO_PAGES: readonly PullRequestDiffPage[] = [];

function sameRevision(
  left: PullRequestDiffResult["revision"],
  right: PullRequestDiffResult["revision"],
): boolean {
  return left?.baseSha === right?.baseSha && left?.headSha === right?.headSha;
}

export function usePullRequestDiff(params: PullRequestDiffParams) {
  const reference = pullRequestTarget(params);
  const target = {
    ...reference,
    input: { ...reference.input, ...(params.commit ? { commit: params.commit } : {}) },
  };
  const key = JSON.stringify(target);
  const firstPageAtom = composerPullRequests.diff(target);
  const refreshFirstPage = useAtomRefresh(firstPageAtom);
  const { refreshing, onRefresh } = usePullToRefresh(firstPageAtom);
  const [state, setState] = useState<{
    key: string;
    cursor: string | null;
    pages: readonly PullRequestDiffPage[];
  }>({ key, cursor: null, pages: NO_PAGES });
  const cursor = state.key === key ? state.cursor : null;
  const query = useEnvironmentQuery(
    composerPullRequests.diff({
      ...target,
      input: { ...target.input, ...(cursor ? { cursor } : {}) },
    }),
  );
  const data = query.data;
  const continuationMoved =
    cursor !== null &&
    data !== null &&
    state.key === key &&
    state.pages.some((page) => !sameRevision(page.result.revision, data.revision));
  const pages = useMemo(() => {
    const loaded = state.key === key ? state.pages : NO_PAGES;
    return data ? retainPullRequestDiffPage(loaded, cursor, data) : loaded;
  }, [cursor, data, key, state.key, state.pages]);
  if (state.key !== key || state.pages !== pages || continuationMoved) {
    setState({ key, cursor: continuationMoved ? null : cursor, pages });
  }

  const [parseCache] = useState(() => new WeakMap<PullRequestDiffResult, ReviewParsedDiff>());
  const parsed = useMemo(
    () => combinePullRequestDiffPages(pages, parseCache, key),
    [key, pages, parseCache],
  );
  const patch = useMemo(() => pages.map((page) => page.result.patch).join("\n"), [pages]);
  const nextCursor = pages.at(-1)?.result.nextCursor ?? null;
  const canLoadMore =
    nextCursor !== null && nextCursor !== cursor && !query.isPending && query.error === null;
  const loadMore = useCallback(() => {
    if (!canLoadMore) return;
    setState({ key, cursor: nextCursor, pages });
  }, [canLoadMore, key, nextCursor, pages, setState]);
  const refresh = useCallback(() => {
    setState({ key, cursor: null, pages: NO_PAGES });
    refreshFirstPage();
  }, [key, refreshFirstPage, setState]);
  const onPullRefresh = useCallback(() => {
    setState({ key, cursor: null, pages: NO_PAGES });
    onRefresh();
  }, [key, onRefresh, setState]);
  return {
    ...query,
    refresh,
    parsed,
    patch,
    nextCursor,
    canLoadMore,
    loadMore,
    refreshing,
    onPullRefresh,
  };
}
