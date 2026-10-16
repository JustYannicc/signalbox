import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePullRequestThread, threadId } from "./pullRequestThreadTesting.ts";

describe("cloud automations watch a cloud thread's pull request", () => {
  it.effect("wakes the thread when CI finishes on the pull request it opened (#397)", () => {
    const { cloud, github, open, tool, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        const linked = (yield* cloud.threadEvents(threadId)).at(-1);
        if (linked?.type !== "thread.pull-request-synced") return expect.unreachable();
        expect(linked.payload.pullRequests).toEqual([
          expect.objectContaining({
            host: "github.test",
            repository: "owner/repo",
            number: 1,
            url: "https://github.test/owner/repo/pull/1",
            source: "created",
            snapshot: null,
          }),
        ]);

        // The first read: open, checks running.
        github.update(1, {
          checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null }],
        });
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;

        // The agent asks Signalbox to watch it, from its machine, by a URL cased the way it
        // was typed: links (and their pr.* events) use the lowercased key.
        const watched = yield* tool("watch_pull_request", {
          url: "https://github.test/Owner/Repo/pull/1",
        });
        expect(watched).toMatchObject({ number: 1, repository: "owner/repo", watching: true });
        yield* cloud.settle;

        // CI passes; the next sync's event reaches the watch, which wakes the agent.
        github.update(1, {
          checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
        });
        yield* cloud.forgetPullRequestPolls(threadId);
        yield* cloud.syncPullRequests(threadId);
        yield* cloud.settle;
        expect(
          (yield* messages(rpc)).some((text) =>
            text.startsWith(
              "Checks passed on pull request #1 (https://github.test/owner/repo/pull/1).",
            ),
          ),
        ).toBe(true);
      }),
    );
  });
});
