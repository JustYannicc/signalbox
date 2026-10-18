import { describe, expect, it } from "@effect/vitest";
import { findQueryForHit } from "@t3tools/client-runtime/state/signalboxSearchModel";
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

import { matchesSearchText, searchSnippet } from "./searchText.ts";

describe("keyword evidence and literal Find", () => {
  it.each(["résumé", "re\u0301sume\u0301", "𐐀résumé"])(
    "keeps source evidence and a literal anchor for %s",
    (token) => {
      const query = token.startsWith("𐐀") ? "𐐨resume" : "resume";
      const prefix = "🙂 filler ".repeat(100);
      const text = `${prefix}${token} ${" unrelated".repeat(50)} second`;
      expect(matchesSearchText(text, `${query} second`, "keyword")).toBe(true);
      expect(matchesSearchText(text, query, "literal")).toBe(false);
      const snippet = searchSnippet(text, `${query} second`);
      expect(snippet).toContain(token);
      expect(snippet.length).toBeLessThanOrEqual(240);
      const findQuery = findQueryForHit(`${query} second`, { kind: "user", snippet });
      expect(findQuery).toBe(token);
      expect(findThreadSearchOccurrences(text, findQuery!)).toEqual([prefix.length]);
    },
  );

  it("keeps a long literal query inside its bounded evidence", () => {
    const query = "r".repeat(200);
    const text = `${"🙂 filler ".repeat(100)}${query} trailing text`;
    const snippet = searchSnippet(text, query);
    expect(snippet).toContain(query);
    expect(snippet.length).toBeLessThanOrEqual(240);
  });
});
