import type { SearchSortKey } from "./SearchIndex.ts";

const compareString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Shared engine-neutral order, also used for cross-home page merging. */
export const compareSearchKeys = (a: SearchSortKey, b: SearchSortKey) =>
  a.matchRank - b.matchRank ||
  compareString(b.threadUpdatedAt, a.threadUpdatedAt) ||
  compareString(a.threadId, b.threadId) ||
  compareString(a.itemId, b.itemId);

export const searchKey = (candidate: SearchSortKey): SearchSortKey => ({
  matchRank: candidate.matchRank,
  threadUpdatedAt: candidate.threadUpdatedAt,
  threadId: candidate.threadId,
  itemId: candidate.itemId,
});
