import { describe, expect, it } from "vite-plus/test";

import { preparePullRequestWriteAttempt } from "@t3tools/client-runtime/pull-request-write-attempt";

describe("pull request write attempts", () => {
  it("reuses a failed snapshot and its reviewed head, then starts a new attempt when either changes", () => {
    let nextId = 0;
    const createOperationId = () => `operation-${++nextId}`;
    const request = {
      projectId: "project-1",
      repository: "acme/web",
      number: 7,
      verdict: "comment",
      body: "Looks good",
      comments: [{ path: "src/app.ts", body: "Check this", line: 4 }],
    };

    const first = preparePullRequestWriteAttempt(undefined, request, "head-a", createOperationId);
    expect(first.input).toMatchObject({ operationId: "operation-1", headSha: "head-a" });

    const retried = preparePullRequestWriteAttempt(
      first.attempt,
      { ...request, comments: [...request.comments] },
      "head-a",
      createOperationId,
    );
    expect(retried).toEqual(first);

    const edited = preparePullRequestWriteAttempt(
      first.attempt,
      { ...request, comments: [{ ...request.comments[0]!, body: "Updated" }] },
      "head-a",
      createOperationId,
    );
    expect(edited.input).toMatchObject({ operationId: "operation-2", headSha: "head-a" });

    const next = preparePullRequestWriteAttempt(
      undefined,
      { ...request, comments: [{ ...request.comments[0]!, body: "Updated" }] },
      "head-a",
      createOperationId,
    );
    expect(next.input).toMatchObject({ operationId: "operation-3", headSha: "head-a" });

    const newHead = preparePullRequestWriteAttempt(
      next.attempt,
      { ...request, comments: [{ ...request.comments[0]!, body: "Updated" }] },
      "head-b",
      createOperationId,
    );
    expect(newHead.input).toMatchObject({ operationId: "operation-4", headSha: "head-b" });
  });

  it("reuses a stored failed attempt across a form remount", () => {
    const request = { body: "Comment", projectId: "project-1" };
    const created = preparePullRequestWriteAttempt(undefined, request, undefined, () => "one");
    const remounted = preparePullRequestWriteAttempt(
      created.attempt,
      { projectId: "project-1", body: "Comment" },
      undefined,
      () => "two",
    );

    expect(remounted.attempt).toEqual(created.attempt);
    expect(remounted.input.operationId).toBe("one");
  });

  it("starts a new attempt when the environment changes", () => {
    const request = { body: "Comment", projectId: "project-1" };
    const created = preparePullRequestWriteAttempt(
      undefined,
      request,
      undefined,
      () => "one",
      "environment-a",
    );
    const sameEnvironment = preparePullRequestWriteAttempt(
      created.attempt,
      { projectId: "project-1", body: "Comment" },
      undefined,
      () => "two",
      "environment-a",
    );
    const otherEnvironment = preparePullRequestWriteAttempt(
      sameEnvironment.attempt,
      request,
      undefined,
      () => "three",
      "environment-b",
    );

    expect(sameEnvironment.attempt.operationId).toBe("one");
    expect(otherEnvironment.attempt.operationId).toBe("three");
  });
});
