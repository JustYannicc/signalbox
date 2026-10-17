import type { FileDiffMetadata } from "@pierre/diffs";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGitDiffFileContentsLoader,
  createPullRequestDiffFileContentsLoader,
} from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

const PR_REVISION = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

const MOVED_PR_REVISION = {
  baseSha: "c".repeat(40),
  headSha: "d".repeat(40),
};

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "src/old-name.ts",
    name: "src/new-name.ts",
  } as FileDiffMetadata;
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads both sides with normalized paths and comparison-scoped cache keys", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: "before\n",
        cacheKey: "comparison-1:old:src/old-name.ts",
      },
      newFile: {
        name: "src/new-name.ts",
        contents: "after\n",
        cacheKey: "comparison-1:new:src/new-name.ts",
      },
    });
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "rename-changed",
        baseRef: "main",
        headRef: "feature",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createPullRequestDiffFileContentsLoader", () => {
  it("keeps an expansion on the displayed revision after the pull request moves", async () => {
    const getDiffFileContents = vi.fn(
      async ({ input }: { input: PullRequestDiffFileContentsInput }) =>
        AsyncResult.success({
          oldContents: `before ${input.revision?.headSha ?? "latest"}\n`,
          newContents: `after ${input.revision?.headSha ?? "latest"}\n`,
        }),
    );
    const source = {
      environmentId: EnvironmentId.make("environment-1"),
      reference: {
        projectId: ProjectId.make("project-1"),
        repository: "owner/repo",
        number: 42,
      },
      commit: null,
      cacheKey: "pull-request:42",
    };
    const oldSnapshotLoader = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
      ...source,
      revision: PR_REVISION,
    });
    const newSnapshotLoader = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
      ...source,
      revision: MOVED_PR_REVISION,
    });

    const oldSnapshot = await oldSnapshotLoader(fileDiff());
    const newSnapshot = await newSnapshotLoader(fileDiff());

    expect(getDiffFileContents).toHaveBeenNthCalledWith(1, {
      environmentId: "environment-1",
      input: {
        ...source.reference,
        revision: PR_REVISION,
        changeType: "rename-changed",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
    expect(oldSnapshot.oldFile?.contents).toBe(`before ${PR_REVISION.headSha}\n`);
    expect(newSnapshot.oldFile?.contents).toBe(`before ${MOVED_PR_REVISION.headSha}\n`);
    expect(oldSnapshot.oldFile?.cacheKey).not.toBe(newSnapshot.oldFile?.cacheKey);
    expect(oldSnapshot.newFile.cacheKey).not.toBe(newSnapshot.newFile.cacheKey);
  });
});
