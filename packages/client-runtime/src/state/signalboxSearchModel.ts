/**
 * Home search's results, shared by web and mobile: the title filter's rows
 * first, then the threads the search service found by content, each thread
 * once, with honest coverage and failure wording.
 */
import { EnvironmentId, type ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type {
  SearchItemKind,
  ThreadSearchHit,
  ThreadSearchResult,
} from "@t3tools/contracts/signalboxSearch";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as Schema from "effect/Schema";

import { folderPath, homeOfThread } from "./foldersModel.ts";

export type SearchFailure = "denied" | "unavailable" | "expired";

/** Why a search page failed, in the terms its message gives the person. */
export function classifySearchFailure(failure: unknown): SearchFailure {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return "unavailable";
  }
  if (failure._tag === "EnvironmentAuthorizationError") return "denied";
  if (
    failure._tag === "ThreadSearchError" &&
    "reason" in failure &&
    failure.reason === "cursor_expired"
  ) {
    return "expired";
  }
  return "unavailable";
}

export const SEARCH_FAILURE_COPY: Record<SearchFailure, string> = {
  denied: "You don't have access to search here.",
  unavailable: "Search couldn't reach every folder.",
  expired: "Access or results changed since you searched.",
};

export const SEARCH_ITEM_KIND_LABEL: Record<SearchItemKind, string> = {
  thread: "Title",
  user: "You",
  assistant: "Agent",
  summary: "Summary",
  tool: "Tool",
  approval: "Approval",
  state: "Status",
};

export interface EnvironmentSearchHit {
  readonly environmentId: EnvironmentId;
  readonly hit: ThreadSearchHit;
}

export interface SearchTitleThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
}

export interface HomeSearchResult<T extends SearchTitleThread> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archived: boolean;
  /** The loaded thread, when the list knows it. */
  readonly thread: T | null;
  /** Where to open: the first content match, or null when only the title matched. */
  readonly hit: ThreadSearchHit | null;
  /** Further content matches in the same thread on the loaded pages. */
  readonly moreHits: number;
}

const encodeSearchResultKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, ThreadId])),
);

export function searchResultKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return encodeSearchResultKey([environmentId, threadId]);
}

export function mergeHomeSearchResults<T extends SearchTitleThread>(input: {
  /** The title and pull request filter's matches, in its order. */
  readonly titleMatches: ReadonlyArray<T>;
  /** Every loaded thread, so a content match can show its live title. */
  readonly threadByKey: ReadonlyMap<string, T>;
  /** The service's hits, in its order. */
  readonly hits: ReadonlyArray<EnvironmentSearchHit>;
}): Array<HomeSearchResult<T>> {
  const hitsByKey = new Map<string, Array<ThreadSearchHit>>();
  const hitOrder: Array<{ readonly key: string; readonly environmentId: EnvironmentId }> = [];
  for (const { environmentId, hit } of input.hits) {
    const key = searchResultKey(environmentId, hit.threadId);
    const existing = hitsByKey.get(key);
    if (existing) {
      existing.push(hit);
    } else {
      hitsByKey.set(key, [hit]);
      hitOrder.push({ key, environmentId });
    }
  }

  const contentOf = (hits: ReadonlyArray<ThreadSearchHit> | undefined) => {
    const content = hits?.filter((hit) => hit.kind !== "thread") ?? [];
    return { hit: content[0] ?? null, moreHits: Math.max(0, content.length - 1) };
  };

  const results: Array<HomeSearchResult<T>> = [];
  const seen = new Set<string>();
  for (const thread of input.titleMatches) {
    const key = searchResultKey(thread.environmentId, thread.id);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      key,
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      archived: false,
      thread,
      ...contentOf(hitsByKey.get(key)),
    });
  }
  for (const { key, environmentId } of hitOrder) {
    if (seen.has(key)) continue;
    seen.add(key);
    const hits = hitsByKey.get(key)!;
    const first = hits[0]!;
    const thread = input.threadByKey.get(key) ?? null;
    results.push({
      key,
      environmentId,
      threadId: first.threadId,
      projectId: thread?.projectId ?? first.projectId,
      title: thread?.title ?? first.title,
      // A loaded thread is live; the index can lag an unarchive.
      archived: thread === null && hits.some((hit) => hit.archived),
      thread,
      ...contentOf(hits),
    });
  }
  return results;
}

export interface SearchCoverageSummary {
  /** Threads the index hasn't reached yet, across every environment searched. */
  readonly pendingThreads: number;
  /** Some threads haven't finished their first indexing pass, count unknown. */
  readonly incomplete: boolean;
  /** Whether some authorized home couldn't answer. */
  readonly unavailable: boolean;
}

/** `latestPages` holds each environment's most recent page; its coverage supersedes earlier pages'. */
export function summarizeSearchCoverage(
  latestPages: ReadonlyArray<ThreadSearchResult>,
): SearchCoverageSummary | null {
  let pendingThreads = 0;
  let incomplete = false;
  let unavailable = false;
  for (const page of latestPages) {
    if (!page.coverage.complete) {
      incomplete = true;
      pendingThreads += page.coverage.pendingThreads;
    }
    unavailable ||= !page.coverage.available;
  }
  return incomplete || unavailable ? { pendingThreads, incomplete, unavailable } : null;
}

/** What a partial answer leaves out, said plainly; null when the answer is whole. */
export function searchCoverageCopy(coverage: SearchCoverageSummary | null): {
  readonly title: string;
  readonly detail: string;
} | null {
  if (coverage === null) return null;
  if (coverage.unavailable) {
    return {
      title: "Some folders couldn't be searched",
      detail: "Matches from them are missing. Retry to search them again.",
    };
  }
  if (coverage.pendingThreads > 0) {
    const threads =
      coverage.pendingThreads === 1 ? "1 thread" : `${coverage.pendingThreads} threads`;
    return {
      title: `${threads} not searchable yet`,
      detail: "They're still being indexed, so their matches aren't here yet.",
    };
  }
  return {
    title: "Search is still catching up",
    detail: "Some older threads aren't indexed yet, so matches may be missing.",
  };
}

/**
 * Where a result lives, named once: its folder path, an organization's name at
 * that organization's top, and nothing at your own top level (#334).
 */
export function searchResultPlace(input: {
  readonly folders: SignalboxFoldersSnapshot | null;
  readonly contexts: SignalboxContextsSnapshot | null;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}): string | null {
  if (input.folders === null) return null;
  const path = folderPath(
    input.folders,
    homeOfThread(input.folders, { id: input.threadId, projectId: input.projectId }),
  );
  if (path.length > 0) return path.map((folder) => folder.name).join(" / ");
  const owner = input.contexts?.contexts.find((context) =>
    context.projectIds.includes(input.projectId),
  );
  return owner?.kind === "organization" ? owner.name : null;
}

/**
 * What in-thread Find should look for so opening a hit lands on it. Find is
 * literal while keyword search matches separated terms, so: the whole query
 * where the hit's snippet holds it, else the first query term the snippet
 * holds (folded the way Find folds). Null when Find can't anchor the hit: a
 * title match, or a snippet with none of the terms.
 */
export function findQueryForHit(
  query: string,
  hit: Pick<ThreadSearchHit, "kind" | "snippet">,
): string | null {
  if (hit.kind === "thread") return null;
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  if (countThreadSearchOccurrences(hit.snippet, trimmed) > 0) return trimmed;
  return (
    trimmed.split(/\s+/u).find((term) => countThreadSearchOccurrences(hit.snippet, term) > 0) ??
    null
  );
}
