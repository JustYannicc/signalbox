import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { findKeywordSearchToken, keywordSearchTerms } from "@t3tools/shared/keywordSearch";

/** A bounded excerpt around the evidence, without changing the indexed item. */
export const searchSnippet = (text: string, query: string) => {
  const literalAt = findThreadSearchOccurrences(text, query)[0];
  const keyword = literalAt === undefined ? findKeywordSearchToken(text, query) : null;
  const at = literalAt ?? keyword?.start ?? 0;
  const length = keyword?.text.length ?? query.length;
  let start = Math.max(0, at - Math.min(80, Math.max(0, 240 - length)));
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start -= 1;
  let end = Math.min(text.length, start + 240);
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end -= 1;
  return text.slice(start, end);
};

export const matchesSearchText = (text: string, query: string, mode: "keyword" | "literal") => {
  if (mode === "literal") return findThreadSearchOccurrences(text, query).length > 0;
  const terms = keywordSearchTerms(query);
  const sourceTerms = new Set(keywordSearchTerms(text));
  return terms.length > 0 && terms.every((term) => sourceTerms.has(term));
};
