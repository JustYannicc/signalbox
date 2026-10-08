/**
 * How the context tool decides that something answers a query. A query is
 * cut into words, minus the ones that say nothing about what was done ("we",
 * "implemented", "drive"). A candidate is evidence when its text holds enough
 * of those words: all of one or two, otherwise at least 60% of them. Anything
 * less is not reported at all, so a search with no evidence says so instead
 * of offering its nearest guess.
 *
 * Words match as case-insensitive substrings, so "mode" finds "modes" and
 * "darkMode". Exact rules on purpose: an agent can predict and refine them.
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  // Grammar.
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "there",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  // Words every piece of work shares, which tell no two apart.
  "add",
  "added",
  "build",
  "built",
  "change",
  "changed",
  "create",
  "created",
  "drive",
  "feature",
  "implement",
  "implemented",
  "made",
  "make",
  "thread",
  "work",
]);

/** The query's distinct searchable words, lowercased, in order. */
export const queryTerms = (query: string): ReadonlyArray<string> => [
  ...new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((word) => word.length >= 2 && !STOPWORDS.has(word)),
  ),
];

/** How many of `terms` a candidate must hold to count as evidence. */
export const termsNeeded = (terms: ReadonlyArray<string>) =>
  terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);

/** The terms found in any of `texts`. */
export const matchTerms = (
  terms: ReadonlyArray<string>,
  texts: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const lowered = texts.map((text) => text.toLowerCase());
  return terms.filter((term) => lowered.some((text) => text.includes(term)));
};

export const isEvidence = (terms: ReadonlyArray<string>, matched: ReadonlyArray<string>) =>
  terms.length > 0 && matched.length >= termsNeeded(terms);

const EXCERPT_RADIUS = 120;

/** `text` around the first of `terms` it holds, on one line; null when it holds none. */
export const excerpt = (text: string, terms: ReadonlyArray<string>): string | null => {
  const lowered = text.toLowerCase();
  const at = terms
    .map((term) => lowered.indexOf(term))
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), Number.POSITIVE_INFINITY);
  if (at === Number.POSITIVE_INFINITY) return null;
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(text.length, at + EXCERPT_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
};
