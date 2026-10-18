import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ThreadSearchHit, ThreadSearchResult } from "@t3tools/contracts/signalboxSearch";
import { describe, expect, it } from "vite-plus/test";

import {
  classifySearchFailure,
  findQueryForHit,
  mergeHomeSearchResults,
  searchCoverageCopy,
  searchResultKey,
  summarizeSearchCoverage,
} from "./signalboxSearchModel.ts";

const environmentId = EnvironmentId.make("cloud");
const projectId = ProjectId.make("project-1");

function hit(threadId: string, overrides: Partial<ThreadSearchHit> = {}): ThreadSearchHit {
  return {
    threadId: ThreadId.make(threadId),
    projectId,
    title: `Indexed ${threadId}`,
    archived: false,
    itemId: `${threadId}:item`,
    entryId: `${threadId}:entry`,
    runId: null,
    position: 0,
    kind: "assistant",
    snippet: "the deploy failed on step two",
    createdAt: null,
    sourceSequence: 3,
    indexedThrough: 3,
    ...overrides,
  };
}

function thread(id: string, title = `Live ${id}`) {
  return { environmentId, id: ThreadId.make(id), projectId, title };
}

function page(
  coverage: Partial<ThreadSearchResult["coverage"]> = {},
  nextCursor: string | null = null,
): ThreadSearchResult {
  return {
    hits: [],
    nextCursor,
    coverage: {
      complete: true,
      indexedThreads: 10,
      pendingThreads: 0,
      available: true,
      ...coverage,
    },
  };
}

describe("mergeHomeSearchResults", () => {
  it("keeps title matches first and lists each thread once", () => {
    const titleMatch = thread("a");
    const results = mergeHomeSearchResults({
      titleMatches: [titleMatch],
      threadByKey: new Map([[searchResultKey(environmentId, titleMatch.id), titleMatch]]),
      hits: [
        { environmentId, hit: hit("b") },
        { environmentId, hit: hit("a", { kind: "user", entryId: "a:first" }) },
        { environmentId, hit: hit("b", { entryId: "b:second" }) },
        { environmentId, hit: hit("a", { kind: "tool" }) },
      ],
    });
    expect(results.map((result) => result.threadId)).toEqual(["a", "b"]);
    expect(results[0]?.hit?.entryId).toBe("a:first");
    expect(results[0]?.moreHits).toBe(1);
    expect(results[1]?.hit?.entryId).toBe("b:entry");
    expect(results[1]?.moreHits).toBe(1);
  });

  it("opens a title-only hit without an anchor", () => {
    const [result] = mergeHomeSearchResults({
      titleMatches: [],
      threadByKey: new Map(),
      hits: [{ environmentId, hit: hit("c", { kind: "thread" }) }],
    });
    expect(result?.hit).toBeNull();
    expect(result?.moreHits).toBe(0);
  });

  it("labels archived threads the client doesn't have loaded", () => {
    const [result] = mergeHomeSearchResults({
      titleMatches: [],
      threadByKey: new Map(),
      hits: [{ environmentId, hit: hit("d", { archived: true }) }],
    });
    expect(result?.archived).toBe(true);
    expect(result?.thread).toBeNull();
    expect(result?.title).toBe("Indexed d");
  });

  it("prefers the loaded thread's current record over a lagging index", () => {
    const live = thread("e", "Renamed since indexing");
    const [result] = mergeHomeSearchResults({
      titleMatches: [],
      threadByKey: new Map([[searchResultKey(environmentId, live.id), live]]),
      hits: [{ environmentId, hit: hit("e", { archived: true }) }],
    });
    expect(result?.title).toBe("Renamed since indexing");
    expect(result?.archived).toBe(false);
    expect(result?.thread).toBe(live);
  });

  it("keeps the same thread apart across environments", () => {
    const other = EnvironmentId.make("other");
    const results = mergeHomeSearchResults({
      titleMatches: [],
      threadByKey: new Map(),
      hits: [
        { environmentId, hit: hit("f") },
        { environmentId: other, hit: hit("f") },
      ],
    });
    expect(results).toHaveLength(2);
  });
});

describe("summarizeSearchCoverage", () => {
  it("says nothing when every environment answered completely", () => {
    expect(summarizeSearchCoverage([page(), page({}, "next")])).toBeNull();
    expect(searchCoverageCopy(summarizeSearchCoverage([page()]))).toBeNull();
  });

  it("adds pending threads across environments", () => {
    const coverage = summarizeSearchCoverage([
      page({ complete: false, pendingThreads: 2 }),
      page({ complete: false, pendingThreads: 3 }),
    ]);
    expect(coverage).toEqual({ pendingThreads: 5, incomplete: true, unavailable: false });
    expect(searchCoverageCopy(coverage)?.title).toBe("5 threads not searchable yet");
  });

  it("is honest about an incomplete index with no count", () => {
    const copy = searchCoverageCopy(summarizeSearchCoverage([page({ complete: false })]));
    expect(copy?.title).toBe("Search is still catching up");
  });

  it("puts an unanswered home ahead of indexing progress", () => {
    const copy = searchCoverageCopy(
      summarizeSearchCoverage([page({ available: false, complete: false, pendingThreads: 4 })]),
    );
    expect(copy?.title).toBe("Some folders couldn't be searched");
  });
});

describe("classifySearchFailure", () => {
  it("maps the service's errors to what the person can do", () => {
    expect(classifySearchFailure({ _tag: "EnvironmentAuthorizationError" })).toBe("denied");
    expect(classifySearchFailure({ _tag: "ThreadSearchError", reason: "cursor_expired" })).toBe(
      "expired",
    );
    expect(classifySearchFailure({ _tag: "ThreadSearchError", reason: "unavailable" })).toBe(
      "unavailable",
    );
    expect(classifySearchFailure(new Error("socket closed"))).toBe("unavailable");
    expect(classifySearchFailure(null)).toBe("unavailable");
  });
});

describe("findQueryForHit", () => {
  it("keeps the whole query where the snippet holds it literally", () => {
    expect(findQueryForHit(" Deploy FAILED ", hit("a"))).toBe("Deploy FAILED");
  });

  it("falls back to the first term the snippet holds for separated keyword matches", () => {
    expect(
      findQueryForHit("cat dog", hit("a", { snippet: "the dog chased a cat round the yard" })),
    ).toBe("cat");
    expect(findQueryForHit("bird dog", hit("a", { snippet: "a DOG barked" }))).toBe("dog");
  });

  it("folds case the way Find does", () => {
    expect(findQueryForHit("ΟΔΟΣ", hit("a", { snippet: "μια οδος εδώ" }))).toBe("ΟΔΟΣ");
  });

  it("hands accent-folded keyword matches to literal Find using their source spelling", () => {
    for (const token of ["résumé", "re\u0301sume\u0301"]) {
      expect(findQueryForHit("resume deployment", hit("a", { snippet: `🙂 ${token} ready` }))).toBe(
        token,
      );
    }
  });

  it("doesn't open Find for a title hit or a snippet without the terms", () => {
    expect(findQueryForHit("deploy", hit("a", { kind: "thread" }))).toBeNull();
    expect(findQueryForHit("rollback", hit("a"))).toBeNull();
    expect(findQueryForHit("   ", hit("a"))).toBeNull();
  });
});
