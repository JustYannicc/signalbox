import { AUTOMATION_WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePullRequestThread, threadId } from "./pullRequestThreadTesting.ts";

const URL = "https://github.test/owner/repo/pull/1";
const PASSED = [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] as const;

/** #397: an agent in a cloud thread asks to merge, and the folder's default Merge gate decides. */
describe("a cloud thread merges its pull request through the Merge gate", () => {
  it.effect("a ready change that's easy to undo merges by itself, and its branch goes", () => {
    const { cloud, github, open, tool, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        github.update(1, { checks: [...PASSED], files: ["app.ts"] });
        yield* cloud.syncPullRequests(threadId);
        const branch = github.pulls[0]!.head;
        const head = github.head(branch);

        const asked = yield* tool("merge_pull_request", { url: URL, note: "Says hi." });
        expect(asked).toMatchObject({ alreadyRequested: false });
        yield* cloud.settle;

        expect(github.pulls[0]).toMatchObject({ merged: true });
        expect(github.head("main")).toBe(head);
        expect(github.head(branch)).toBeNull();
        expect(github.calls).toContain("PUT api/repos/owner/repo/pulls/1/merge");
        expect(yield* messages(rpc)).toContain(
          `Merged owner/repo#1 (${URL}) at ${head!.slice(0, 7)} (ready and easy to undo) and deleted its branch. Wrap up and hand the work back.`,
        );
      }),
    );
  });

  it.effect("an unready one goes back to the agent, and nothing merges", () => {
    const { cloud, github, open, tool, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        github.update(1, {
          checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
          files: ["app.ts"],
          openThreads: 1,
        });
        yield* cloud.syncPullRequests(threadId);
        yield* tool("merge_pull_request", { url: URL });
        yield* cloud.settle;

        expect(github.pulls[0]).toMatchObject({ merged: false });
        expect(yield* messages(rpc)).toContain(
          `Not merging owner/repo#1 (${URL}) yet: checks failed: test; 1 review thread is unresolved. Fix that (watch_pull_request wakes you when checks finish), then call merge_pull_request again.`,
        );
      }),
    );
  });

  it.effect("a migration asks the person with its evidence, and merges on their yes", () => {
    const { cloud, github, open, tool, getRun, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        github.update(1, { checks: [...PASSED], files: ["app.ts", "db/migrations/0002_hi.sql"] });
        yield* cloud.syncPullRequests(threadId);
        const head = github.head(github.pulls[0]!.head)!;

        const { waitId } = (yield* tool("merge_pull_request", { url: URL })) as {
          readonly waitId: string;
        };
        yield* cloud.settle;
        const ask = (yield* getRun(waitId)).steps.find((step) => step.verb === "ask");
        expect(ask?.status).toBe("waiting");
        const [shown] = (ask?.args ?? []) as ReadonlyArray<{ readonly question?: string }>;
        expect(shown?.question).toBe(
          [
            "Say hi",
            URL,
            `At ${head.slice(0, 7)}. Checks: all 1 passed at ${head.slice(0, 7)}. Review threads: all resolved. Changes 2 files.`,
            "Asking because it changes a database migration (db/migrations/0002_hi.sql).",
          ].join("\n\n"),
        );
        expect(github.pulls[0]).toMatchObject({ merged: false });

        yield* rpc[AUTOMATION_WS_METHODS.automationsAnswer]({
          runId: waitId,
          stepKey: ask!.key,
          choice: "merge",
        });
        yield* cloud.settle;
        expect(github.pulls[0]).toMatchObject({ merged: true });
        expect(yield* messages(rpc)).toContain(
          `Merged owner/repo#1 (${URL}) at ${head.slice(0, 7)} (approved) and deleted its branch. Wrap up and hand the work back.`,
        );
      }),
    );
  });

  it.effect("a push after the evidence was read fails the merge at GitHub (#461)", () => {
    const { cloud, github, open, tool, getRun, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        github.update(1, { checks: [...PASSED], files: ["db/migrations/0002_hi.sql"] });
        yield* cloud.syncPullRequests(threadId);
        const { waitId } = (yield* tool("merge_pull_request", { url: URL })) as {
          readonly waitId: string;
        };
        yield* cloud.settle;
        const ask = (yield* getRun(waitId)).steps.find((step) => step.verb === "ask");

        // Someone pushes to the branch while the person reads the request.
        const branch = github.pulls[0]!.head;
        const approved = github.head(branch)!;
        github.pushEmptyCommit(branch);

        yield* rpc[AUTOMATION_WS_METHODS.automationsAnswer]({
          runId: waitId,
          stepKey: ask!.key,
          choice: "merge",
        });
        yield* cloud.settle;
        expect(github.pulls[0]).toMatchObject({ merged: false });
        expect(yield* messages(rpc)).toContain(
          `Not merging owner/repo#1 (${URL}): new commits landed after ${approved.slice(0, 7)}, which is what was checked. Call merge_pull_request again so the gate looks at what's there now.`,
        );
      }),
    );
  });
});
