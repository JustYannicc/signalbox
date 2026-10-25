import { describe, expect, it } from "@effect/vitest";
import type { ProjectSearchContentsInput, ProjectSearchContentsResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { collectContentSearch } from "@t3tools/client-runtime/rpc/contentSearch";

const input: ProjectSearchContentsInput = {
  cwd: "/folder",
  query: "sentence",
  limit: 2,
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
};
const match = (path: string) => ({
  path,
  lineNumber: 1,
  lineContent: "sentence",
  matchRanges: [{ start: 0, end: 8 }],
});

describe("content search continuation", () => {
  it.effect("follows empty scan pages and keeps earlier matches", () =>
    Effect.gen(function* () {
      const calls: Array<string | undefined> = [];
      const emitted: Array<ProjectSearchContentsResult> = [];
      const pages = [
        { matches: [], truncated: true, nextCursor: "page-2" },
        { matches: [match("old.txt")], truncated: true, nextCursor: "page-3" },
        { matches: [match("nested/note.txt")], truncated: false },
      ];
      const result = yield* collectContentSearch(
        input,
        (page) => {
          calls.push(page.cursor);
          return Effect.succeed(pages[calls.length - 1]!);
        },
        (page) =>
          Effect.sync(() => {
            emitted.push(page);
          }),
      );
      expect(calls).toEqual([undefined, "page-2", "page-3"]);
      expect(result.matches.map((row) => row.path)).toEqual(["old.txt", "nested/note.txt"]);
      expect(result.truncated).toBe(false);
      expect(emitted).toHaveLength(2);
    }),
  );

  it.effect("stops at the caller's result limit and preserves truncation", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* collectContentSearch(input, () => {
        calls++;
        return Effect.succeed({
          matches: [match("one"), match("two")],
          truncated: true,
          nextCursor: "more",
        });
      });
      expect(calls).toBe(1);
      expect(result.matches).toHaveLength(2);
      expect(result.truncated).toBe(true);
    }),
  );

  it.effect("keeps legacy one-page servers and regex fallback messages", () =>
    Effect.gen(function* () {
      const result = yield* collectContentSearch(input, () =>
        Effect.succeed({ matches: [], truncated: false, regexFallbackError: "Invalid expression" }),
      );
      expect(result).toEqual({
        matches: [],
        truncated: false,
        regexFallbackError: "Invalid expression",
      });
    }),
  );
});
