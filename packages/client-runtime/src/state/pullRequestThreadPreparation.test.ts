import { GitPreparePullRequestThreadResult, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestThreadPreparationOperationId,
  resolvePreparedPullRequestThread,
} from "@t3tools/client-runtime/state/pull-request-thread-preparation";

const draftThreadId = ThreadId.make("thread-draft");
const reference = "https://github.com/acme/app/pull/42";

const decodeResult = Schema.decodeUnknownSync(GitPreparePullRequestThreadResult);
const result = (extra: Record<string, unknown>) =>
  decodeResult({
    pullRequest: {
      number: 42,
      title: "Fix the thing",
      url: reference,
      baseBranch: "main",
      headBranch: "fix-thing",
      state: "open",
    },
    branch: "fix-thing",
    worktreePath: "/work/fix-thing",
    ...extra,
  });

describe("pullRequestThreadPreparationOperationId", () => {
  it("repeats for a retry of the same draft, reference and mode", () => {
    const input = { threadId: draftThreadId, reference, mode: "worktree" } as const;
    expect(pullRequestThreadPreparationOperationId(input)).toBe(
      pullRequestThreadPreparationOperationId({ ...input }),
    );
  });

  it("differs when the draft, the reference or the mode differs", () => {
    const base = pullRequestThreadPreparationOperationId({
      threadId: draftThreadId,
      reference,
      mode: "worktree",
    });
    expect(
      new Set([
        base,
        pullRequestThreadPreparationOperationId({
          threadId: ThreadId.make("thread-other"),
          reference,
          mode: "worktree",
        }),
        pullRequestThreadPreparationOperationId({
          threadId: draftThreadId,
          reference: "https://github.com/acme/app/pull/43",
          mode: "worktree",
        }),
        pullRequestThreadPreparationOperationId({
          threadId: draftThreadId,
          reference,
          mode: "local",
        }),
      ]).size,
    ).toBe(4);
  });
});

describe("resolvePreparedPullRequestThread", () => {
  it("keeps the self-hosted checkout when the server made no thread", () => {
    expect(
      resolvePreparedPullRequestThread(draftThreadId, result({ isOnPullRequestHead: false })),
    ).toEqual({
      kind: "host-checkout",
      branch: "fix-thing",
      worktreePath: "/work/fix-thing",
      isOnPullRequestHead: false,
    });
  });

  it("adopts the server thread when it is the requested one", () => {
    expect(
      resolvePreparedPullRequestThread(draftThreadId, result({ threadId: draftThreadId })),
    ).toEqual({ kind: "server-thread", threadId: draftThreadId });
  });

  it("refuses a server thread other than the requested one", () => {
    expect(
      resolvePreparedPullRequestThread(draftThreadId, result({ threadId: "thread-elsewhere" })),
    ).toEqual({ kind: "mismatch", threadId: ThreadId.make("thread-elsewhere") });
  });
});
