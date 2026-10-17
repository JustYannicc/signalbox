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

const pullRequestRefs = () => ({
  base: { sha: baseSha },
  head: { sha: headSha },
  changed_files: 101,
});

const compareRefs = () => ({
  base_commit: { sha: baseSha },
  head_commit: { sha: headSha },
  merge_base_commit: { sha: mergeBaseSha },
  changed_files: 101,
});

const file = (number: number) => ({
  filename: `src/file-${number}.ts`,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new\n",
});

const sameRevisionAnswers = () => ({
  pullRequestDiffRefs: [
    pullRequestRefs(),
    pullRequestRefs(),
    pullRequestRefs(),
    pullRequestRefs(),
    pullRequestRefs(),
  ],
  pullRequestDiffMergeBase: [
    compareRefs(),
    compareRefs(),
    compareRefs(),
    compareRefs(),
    compareRefs(),
  ],
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
    expect(calls.filter((call) => call.operation === "pullRequestDiffRefs")).toHaveLength(5);
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

const compareFile = () => ({
  base_commit: { sha: baseSha },
  head_commit: { sha: headSha },
  merge_base_commit: { sha: baseSha },
  files: [
    {
      filename: "src/a.ts",
      status: "modified",
      previous_filename: null,
      additions: 1,
      deletions: 1,
    },
  ],
});

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

it.effect("reads old and new file contents at the pinned diff revisions", () =>
  Effect.gen(function* () {
    const { api, calls } = mockApi({
      pullRequestDiffFileContentsMetadata: [compareFile()],
      pullRequestDiffFileContents: [contentFile("b2xkCg=="), contentFile("bmV3Cg==")],
    });

    const contents = yield* pullRequestDiffFileContents(api, "token", "acme/web", 7, contentsInput);

    expect(contents).toEqual({ oldContents: "old\n", newContents: "new\n" });
    expect(
      calls
        .filter((call) => call.operation === "pullRequestDiffFileContents")
        .map((call) => call.query?.ref),
    ).toEqual([baseSha, headSha]);
  }),
);

it.effect("fails the whole expansion when either pinned file version is unavailable", () =>
  Effect.gen(function* () {
    const { api } = mockApi({
      pullRequestDiffFileContentsMetadata: [compareFile()],
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
