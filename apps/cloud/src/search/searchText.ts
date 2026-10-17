import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
const termsOf = (query: string) => fold(query).match(/[\p{L}\p{N}_]+/gu) ?? [];

/** A bounded excerpt around the evidence, without changing the indexed item. */
export const searchSnippet = (text: string, query: string) => {
  const at =
    findThreadSearchOccurrences(text, query)[0] ??
    Math.max(0, text.toLowerCase().indexOf(termsOf(query)[0] ?? query.toLowerCase()));
  const start = Math.max(0, at - 80);
  return text.slice(start, start + 240);
};

export const matchesSearchText = (text: string, query: string, mode: "keyword" | "literal") =>
  mode === "literal"
    ? findThreadSearchOccurrences(text, query).length > 0
    : termsOf(query).length > 0 && termsOf(query).every((term) => new Set(termsOf(text)).has(term));
