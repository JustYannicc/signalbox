const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");

export const keywordSearchTerms = (query: string) => fold(query).match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Keeps source spelling and UTF-16 offsets when keyword folding removes accents. */
export const findKeywordSearchToken = (text: string, query: string) => {
  const terms = new Set(keywordSearchTerms(query));
  if (terms.size === 0) return null;
  for (const match of text.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*/gu)) {
    if (terms.has(fold(match[0]))) return { text: match[0], start: match.index };
  }
  return null;
};
