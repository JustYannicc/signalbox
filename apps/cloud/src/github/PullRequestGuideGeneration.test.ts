import {
  ProviderInstanceId,
  type ModelSelection,
  type PullRequestActivity,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ModelPoolRoute } from "../models/ModelProtocol.ts";
import * as ModelCompletion from "../models/ModelCompletion.ts";
import * as PullRequestGuideGeneration from "./PullRequestGuideGeneration.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER_BASE = "c".repeat(40);
const pool: ModelPoolRoute = { objectName: "owner:folder", userId: "owner" };
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const detail = (changedFiles = 1, headSha = HEAD) =>
  ({
    number: 42,
    title: "Add search",
    body: "Add a fast search path.",
    baseBranch: "main",
    headBranch: "search",
    headSha,
    changedFiles,
  }) as PullRequestDetail;

const activity: PullRequestActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
};

const diff = (
  patch: string,
  overrides: Partial<{
    readonly baseSha: string;
    readonly headSha: string;
    readonly truncated: boolean;
    readonly nextCursor: string | null;
    readonly omittedFileStats: ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
  }> = {},
) => ({
  revision: {
    baseSha: overrides.baseSha ?? BASE,
    headSha: overrides.headSha ?? HEAD,
  },
  patch,
  truncated: overrides.truncated ?? false,
  nextCursor: overrides.nextCursor ?? null,
  ...(overrides.omittedFileStats === undefined
    ? {}
    : { omittedFileStats: overrides.omittedFileStats }),
});

const filePatch = (path: string, oldLine: string, newLine: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +2 @@",
    `-${oldLine}`,
    `+${newLine}`,
    "",
  ].join("\n");

const generated = (excerpts: ReadonlyArray<unknown> = [], files: ReadonlyArray<unknown> = []) =>
  JSON.stringify({
    stops: [
      {
        title: "The search change",
        summary:
          "The search path now handles queries directly. This is the main behavior the next stop builds on.",
        attention: null,
        excerpts,
        files,
        notes: [],
        questions: [],
      },
    ],
  });

const layer = (complete: ModelCompletion.ModelCompletion["Service"]["complete"]) =>
  PullRequestGuideGeneration.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ModelCompletion.ModelCompletion,
        ModelCompletion.ModelCompletion.of({ complete }),
      ),
    ),
  );

const input = (
  readDiff: PullRequestGuideGeneration.PullRequestGuideGenerationInput["readDiff"],
  overrides: Partial<PullRequestGuideGeneration.PullRequestGuideGenerationInput> = {},
) => ({
  detail: detail(),
  activity,
  modelSelection,
  pool,
  readDiff,
  ...overrides,
});

describe("PullRequestGuideGeneration", () => {
  it.effect("reads all slices at one revision and normalizes references against its hunks", () => {
    const cursors: Array<string | undefined> = [];
    const requests: Array<Parameters<ModelCompletion.ModelCompletion["Service"]["complete"]>[0]> =
      [];

    return Effect.gen(function* () {
      const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
      const result = yield* model.generate(
        input(
          (cursor) => {
            cursors.push(cursor);
            return Effect.succeed(
              cursor === undefined
                ? diff(filePatch("src/search.ts", "old", "new"), { nextCursor: "page-2" })
                : diff(filePatch("src/rank.ts", "low", "high")),
            );
          },
          { detail: detail(2) },
        ),
      );

      expect(cursors).toEqual([undefined, "page-2"]);
      expect(result.revision).toEqual({ baseSha: BASE, headSha: HEAD });
      expect(result.guide.stops[0]?.excerpts).toEqual([
        { path: "src/search.ts", side: "new", start: 2, end: 2, caption: "" },
      ]);
      expect(result.guide.stops.at(-1)).toMatchObject({
        title: "Other files",
        files: [{ path: "src/rank.ts" }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.prompt).toContain("diff --git a/src/search.ts b/src/search.ts");
      expect(requests[0]?.prompt).toContain("diff --git a/src/rank.ts b/src/rank.ts");
    }).pipe(
      Effect.provide(
        layer((request) => {
          requests.push(request);
          return Effect.succeed(
            generated(
              [
                { path: "src/search.ts", side: "new", start: 1, end: 4, caption: "" },
                { path: "src/missing.ts", side: "new", start: 1, end: 2, caption: "" },
              ],
              [{ path: "src/missing.ts", note: "not in the change" }],
            ),
          );
        }),
      ),
    );
  });

  it.effect("uses the caller's model route and includes the supplied remote diff", () => {
    const requests: Array<Parameters<ModelCompletion.ModelCompletion["Service"]["complete"]>[0]> =
      [];

    return Effect.gen(function* () {
      const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
      const result = yield* model.generate(
        input(() => Effect.succeed(diff(filePatch("src/search.ts", "old", "new"))), {
          instructions: "Prefer the public contract first.",
        }),
      );

      expect(result.revision).toEqual({ baseSha: BASE, headSha: HEAD });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.pool).toBe(pool);
      expect(requests[0]?.modelSelection).toBe(modelSelection);
      expect(requests[0]?.prompt).toContain("immutable remote comparison");
      expect(requests[0]?.prompt).toContain("<pr_title>Add search</pr_title>");
      expect(requests[0]?.prompt).toContain("Add a fast search path.");
      expect(requests[0]?.prompt).toContain("<settled_review>\n(nothing)\n</settled_review>");
      expect(requests[0]?.prompt).toContain("diff --git a/src/search.ts b/src/search.ts");
      expect(requests[0]?.prompt).toContain("Prefer the public contract first.");
      expect(requests[0]?.prompt).not.toContain("git diff --stat");
    }).pipe(
      Effect.provide(
        layer((request) => {
          requests.push(request);
          return Effect.succeed(generated());
        }),
      ),
    );
  });

  it.effect("rejects a changed head before completing", () =>
    Effect.gen(function* () {
      const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
      const error = yield* Effect.flip(
        model.generate(
          input(() =>
            Effect.succeed(
              diff(filePatch("src/search.ts", "old", "new"), { headSha: "d".repeat(40) }),
            ),
          ),
        ),
      );

      expect(error).toMatchObject({ code: "revision-mismatch" });
    }).pipe(Effect.provide(layer(() => Effect.succeed(generated())))),
  );

  it.effect("rejects base changes between diff pages", () =>
    Effect.gen(function* () {
      const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
      const error = yield* Effect.flip(
        model.generate(
          input(
            (cursor) =>
              Effect.succeed(
                cursor === undefined
                  ? diff(filePatch("src/a.ts", "a", "b"), { nextCursor: "page-2" })
                  : diff(filePatch("src/b.ts", "c", "d"), { baseSha: OTHER_BASE }),
              ),
            { detail: detail(2) },
          ),
        ),
      );

      expect(error).toMatchObject({ code: "revision-mismatch" });
    }).pipe(Effect.provide(layer(() => Effect.succeed(generated())))),
  );

  it.effect("rejects truncated and omitted diff data", () =>
    Effect.gen(function* () {
      const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
      for (const slice of [
        diff(filePatch("src/a.ts", "a", "b"), { truncated: true }),
        diff(filePatch("src/a.ts", "a", "b"), {
          omittedFileStats: [{ path: "src/image.png", additions: 1, deletions: 0 }],
        }),
      ]) {
        const error = yield* Effect.flip(model.generate(input(() => Effect.succeed(slice))));
        expect(error).toMatchObject({ code: "incomplete-diff" });
      }
    }).pipe(Effect.provide(layer(() => Effect.succeed(generated())))),
  );

  it.effect(
    "rejects a missing changed-file entry or a file with no hunk or complete metadata",
    () =>
      Effect.gen(function* () {
        const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
        const missingFile = yield* Effect.flip(
          model.generate(
            input(() => Effect.succeed(diff(filePatch("src/a.ts", "a", "b"))), {
              detail: detail(2),
            }),
          ),
        );
        const missingPatch = yield* Effect.flip(
          model.generate(
            input(() =>
              Effect.succeed(
                diff(
                  ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", ""].join(
                    "\n",
                  ),
                ),
              ),
            ),
          ),
        );

        expect(missingFile).toMatchObject({ code: "incomplete-diff" });
        expect(missingPatch).toMatchObject({ code: "incomplete-diff" });
      }).pipe(Effect.provide(layer(() => Effect.succeed(generated())))),
  );

  it.effect("rejects invalid structured output", () =>
    Effect.gen(function* () {
      const model = yield* PullRequestGuideGeneration.PullRequestGuideGeneration;
      const error = yield* Effect.flip(
        model.generate(input(() => Effect.succeed(diff(filePatch("src/search.ts", "old", "new"))))),
      );

      expect(error).toMatchObject({
        _tag: "TextGenerationError",
        operation: "generateReviewGuide",
      });
    }).pipe(Effect.provide(layer(() => Effect.succeed("not json")))),
  );
});
