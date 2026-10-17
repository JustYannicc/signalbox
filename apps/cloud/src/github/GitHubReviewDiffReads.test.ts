import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProjectId } from "@t3tools/contracts";

import type { GitHubApi } from "./GitHubApi.ts";
import { pullRequestDiff, pullRequestDiffFileContents } from "./GitHubReviewReads.ts";

interface RestCall {
  readonly operation: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>> | undefined;
}

const mockApi = (answers: Record<string, Array<unknown | null>>) => {
  const calls: RestCall[] = [];
  const api = {
    host: "github.com",
    rest: (
      operation: string,
      _token: string,
      path: string,
      query?: Readonly<Record<string, string>>,
    ) => {
      calls.push({ operation, path, query });
      const answer = answers[operation]?.shift() ?? null;
      return Effect.succeed(
        answer === null ? null : typeof answer === "string" ? answer : JSON.stringify(answer),
      );
    },
  } as unknown as GitHubApi;
  return { api, calls };
};

const baseSha = "b".repeat(40);
const mergeBaseSha = "c".repeat(40);
const headSha = "a".repeat(40);
const parentSha = "d".repeat(40);
const pullRequestRef = {
  projectId: ProjectId.make("project"),
  repository: "acme/web",
  number: 7,
};

const pullRequestRefs = (base = baseSha, head = headSha, changedFiles = 101) => ({
  base: { sha: base },
  head: { sha: head },
  changed_files: changedFiles,
});

const compareRefs = (base = baseSha, mergeBase = mergeBaseSha) => ({
  base_commit: { sha: base },
  merge_base_commit: { sha: mergeBase },
});

const file = (number: number) => ({
  filename: `src/file-${number}.ts`,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new\n",
});

const sameRevisionAnswers = () => ({
  pullRequestDiffRefs: [pullRequestRefs(), pullRequestRefs(), pullRequestRefs(), pullRequestRefs()],
  pullRequestDiffMergeBase: [compareRefs()],
});

it.effect("paginates a pull-request diff while binding every slice to the same revision", () =>
  Effect.gen(function* () {
    const answers = {
      ...sameRevisionAnswers(),
      pullRequestDiff: [Array.from({ length: 100 }, (_, index) => file(index)), [file(100)]],
    };
    const { api, calls } = mockApi(answers);

    const first = yield* pullRequestDiff(api, "token", "acme/web", 7, pullRequestRef);
    expect(first?.revision).toEqual({ baseSha: mergeBaseSha, headSha });
    expect(first?.nextCursor).not.toBeNull();
    if (first?.nextCursor == null) throw new Error("expected another diff slice");

    const second = yield* pullRequestDiff(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      cursor: first.nextCursor,
    });

    expect(second?.revision).toEqual({ baseSha: mergeBaseSha, headSha });
    expect(second?.nextCursor).toBeNull();
    expect(
      calls.filter((call) => call.operation === "pullRequestDiff").map((call) => call.query?.page),
    ).toEqual(["1", "2"]);
    expect(calls.filter((call) => call.operation === "pullRequestDiffRefs")).toHaveLength(4);
    expect(calls.filter((call) => call.operation === "pullRequestDiffMergeBase")).toEqual([
      expect.objectContaining({
        path: `/repos/acme/web/compare/${baseSha}...${headSha}`,
        query: { per_page: "1", page: "2" },
      }),
    ]);
  }),
);

it.effect(
  "returns page one for a changed cursor revision and fails cleanly on a mid-page move",
  () =>
    Effect.gen(function* () {
      const nextBase = "e".repeat(40);
      const nextHead = "f".repeat(40);
      const nextMergeBase = "9".repeat(40);
      const { api, calls } = mockApi({
        pullRequestDiffRefs: [
          pullRequestRefs(),
          pullRequestRefs(),
          pullRequestRefs(),
          pullRequestRefs(nextBase, nextHead, 150),
          pullRequestRefs(nextBase, nextHead, 150),
          pullRequestRefs(nextBase, nextHead, 150),
        ],
        pullRequestDiffMergeBase: [compareRefs(), compareRefs(nextBase, nextMergeBase)],
        pullRequestDiff: [
          Array.from({ length: 100 }, (_, index) => file(index)),
          [file(100)],
          Array.from({ length: 100 }, (_, index) => file(index)),
        ],
      });

      const first = yield* pullRequestDiff(api, "token", "acme/web", 7, pullRequestRef);
      if (first?.nextCursor == null) throw new Error("expected another diff slice");

      const raced = yield* pullRequestDiff(api, "token", "acme/web", 7, {
        ...pullRequestRef,
        cursor: first.nextCursor,
      }).pipe(Effect.flip);
      expect(raced.operation).toBe("pullRequestDiff");

      const restarted = yield* pullRequestDiff(api, "token", "acme/web", 7, {
        ...pullRequestRef,
        cursor: first.nextCursor,
      });
      expect(restarted?.revision).toEqual({ baseSha: nextMergeBase, headSha: nextHead });
      expect(restarted?.nextCursor).not.toBeNull();
      expect(
        calls
          .filter((call) => call.operation === "pullRequestDiff")
          .map((call) => call.query?.page),
      ).toEqual(["1", "2", "1"]);
      expect(
        calls
          .filter((call) => call.operation === "pullRequestDiffMergeBase")
          .map((call) => call.path),
      ).toEqual([
        `/repos/acme/web/compare/${baseSha}...${headSha}`,
        `/repos/acme/web/compare/${nextBase}...${nextHead}`,
      ]);
    }),
);

it.effect("stops at GitHub's 3,000-file limit and reports the remaining diff as truncated", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestDiffRefs: Array.from({ length: 60 }, () =>
        pullRequestRefs(baseSha, headSha, 4_000),
      ),
      pullRequestDiffMergeBase: [compareRefs()],
      pullRequestDiff: Array.from({ length: 30 }, (_, page) =>
        Array.from({ length: 100 }, (_, index) => file(page * 100 + index)),
      ),
    });

    const initial = yield* pullRequestDiff(api, "token", "acme/web", 7, pullRequestRef);
    if (initial === null) throw new Error("expected a diff page");
    let current = initial;
    for (let page = 2; page <= 30; page += 1) {
      if (current.nextCursor === null) throw new Error(`expected diff page ${page}`);
      const next = yield* pullRequestDiff(api, "token", "acme/web", 7, {
        ...pullRequestRef,
        cursor: current.nextCursor,
      });
      if (next === null) throw new Error(`expected diff page ${page}`);
      current = next;
    }

    expect(current.nextCursor).toBeNull();
    expect(current.truncated).toBe(true);
    expect(calls.filter((call) => call.operation === "pullRequestDiff")).toHaveLength(30);
    expect(calls.filter((call) => call.operation === "pullRequestDiffMergeBase")).toHaveLength(1);
  }),
);

it.effect("resolves abbreviated commit ids and rejects a cursor reused for another commit", () =>
  Effect.gen(function* () {
    const abbreviated = "abcdef1";
    const selectedSha = `${abbreviated}${"a".repeat(33)}`;
    const otherSha = "f".repeat(40);
    const commit = (sha: string) => ({ sha, parents: [{ sha: parentSha }] });
    const { api, calls } = mockApi({
      pullRequestDiffCommit: [commit(selectedSha), commit(selectedSha), commit(otherSha)],
      pullRequestDiff: [
        { files: Array.from({ length: 100 }, (_, index) => file(index)) },
        { files: [file(100)] },
      ],
    });

    const first = yield* pullRequestDiff(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      commit: abbreviated,
    });
    expect(first?.revision).toEqual({ baseSha: parentSha, headSha: selectedSha });
    if (first?.nextCursor == null) throw new Error("expected another diff slice");

    const second = yield* pullRequestDiff(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      commit: abbreviated,
      cursor: first.nextCursor,
    });
    expect(second?.revision?.headSha).toBe(selectedSha);

    const error = yield* pullRequestDiff(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      commit: otherSha,
      cursor: first.nextCursor,
    }).pipe(Effect.flip);
    expect(error.operation).toBe("pullRequestDiff");
    expect(
      calls.filter((call) => call.operation === "pullRequestDiff").map((call) => call.path),
    ).toEqual([`/repos/acme/web/commits/${selectedSha}`, `/repos/acme/web/commits/${selectedSha}`]);
  }),
);

const contentFile = (content: string) => ({
  type: "file",
  encoding: "base64",
  size: 4,
  content,
});

const contentsInput = {
  ...pullRequestRef,
  changeType: "change" as const,
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  revision: { baseSha, headSha },
};

it.effect("reads any file at pinned revisions without listing the full comparison", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestDiffFileContents: [contentFile("b2xkCg=="), contentFile("bmV3Cg==")],
    });

    const contents = yield* pullRequestDiffFileContents(api, "token", "acme/web", 7, {
      ...contentsInput,
      oldPath: "src/file-301.ts",
      newPath: "src/file-301.ts",
    });

    expect(contents).toEqual({ oldContents: "old\n", newContents: "new\n" });
    expect(calls.some((call) => call.operation === "pullRequestDiffFileContentsMetadata")).toBe(
      false,
    );
    expect(
      calls
        .filter((call) => call.operation === "pullRequestDiffFileContents")
        .map((call) => call.query?.ref),
    ).toEqual([baseSha, headSha]);
  }),
);

it.effect("supports a root-commit new file and leaves absent sides empty", () =>
  Effect.gen(function* () {
    const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const { api, calls } = mockApi({
      pullRequestDiffCommit: [{ sha: headSha, parents: [] }],
      pullRequestDiff: [
        { files: [{ filename: "root.ts", status: "added", patch: "@@ -0,0 +1 @@\n+new\n" }] },
      ],
      pullRequestDiffFileContents: [contentFile("bmV3Cg=="), contentFile("b2xkCg==")],
    });

    const diff = yield* pullRequestDiff(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      commit: headSha,
    });
    if (diff === null || diff.revision === undefined)
      throw new Error("expected a root commit diff");
    expect(diff.revision).toEqual({ baseSha: emptyTreeSha, headSha });

    const added = yield* pullRequestDiffFileContents(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      commit: headSha,
      revision: diff.revision,
      changeType: "new",
      oldPath: "root.ts",
      newPath: "root.ts",
    });
    expect(added).toEqual({ oldContents: "", newContents: "new\n" });

    const deleted = yield* pullRequestDiffFileContents(api, "token", "acme/web", 7, {
      ...pullRequestRef,
      revision: { baseSha, headSha },
      changeType: "deleted",
      oldPath: "src/removed.ts",
      newPath: "src/removed.ts",
    });
    expect(deleted).toEqual({ oldContents: "old\n", newContents: "" });
    const contentsCalls = calls.filter((call) => call.operation === "pullRequestDiffFileContents");
    expect(contentsCalls.map((call) => [call.path, call.query?.ref])).toEqual([
      ["/repos/acme/web/contents/root.ts", headSha],
      ["/repos/acme/web/contents/src/removed.ts", baseSha],
    ]);
    expect(calls.some((call) => call.operation === "pullRequestDiffFileContentsMetadata")).toBe(
      false,
    );
  }),
);

it.effect("fails the whole expansion when either pinned file version is unavailable", () =>
  Effect.gen(function* () {
    const { api } = mockApi({
      pullRequestDiffFileContents: [contentFile("b2xkCg=="), null],
    });

    const error = yield* pullRequestDiffFileContents(
      api,
      "token",
      "acme/web",
      7,
      contentsInput,
    ).pipe(Effect.flip);

    expect(error.operation).toBe("pullRequestDiffFileContents");
  }),
);

it.effect("rejects file contents whose commit and revision disagree before reading GitHub", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({});

    const error = yield* pullRequestDiffFileContents(api, "token", "acme/web", 7, {
      ...contentsInput,
      commit: "f".repeat(40),
    }).pipe(Effect.flip);

    expect(error.operation).toBe("pullRequestDiffFileContents");
    expect(calls).toEqual([]);
  }),
);
