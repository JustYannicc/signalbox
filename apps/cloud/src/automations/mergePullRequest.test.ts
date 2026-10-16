import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
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

  it.effect("a branch another open pull request builds on stays after the merge", () => {
    const { cloud, github, open, tool, messages, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        github.update(1, { checks: [...PASSED], files: ["app.ts"] });
        yield* cloud.syncPullRequests(threadId);
        const branch = github.pulls[0]!.head;
        const head = github.head(branch);
        github.pulls.push({ ...github.pulls[0]!, number: 2, head: "stacked", base: branch });

        yield* tool("merge_pull_request", { url: URL });
        yield* cloud.settle;

        expect(github.pulls[0]).toMatchObject({ merged: true });
        expect(github.head(branch)).toBe(head);
        expect(yield* messages(rpc)).toContain(
          `Merged owner/repo#1 (${URL}) at ${head!.slice(0, 7)} (ready and easy to undo). Wrap up and hand the work back.`,
        );
      }),
    );
  });

  it.effect("an agent's merging automation merges only once a person publishes it (#5)", () => {
    const { cloud, github, open, tool, getRun, run } = makePullRequestThread();
    const source = `export const meta = { name: "Merge it" } as const;
export default workflow(async (w) => {
  return await w.call("Merge it", "signalbox.pull_request_action", { threadId: "${threadId}", url: "${URL}", action: "merge" });
});`;
    const compiled = compileForCloud(source);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    return run(
      Effect.gen(function* () {
        const { rpc } = yield* open;
        yield* cloud.syncPullRequests(threadId);
        const saved = (yield* tool("automation_save", {
          source,
          compiled: compiled.compiled,
          draft: true,
        })) as { readonly automation: { readonly automationId: string } };
        const automationId = saved.automation.automationId;
        const runIt = Effect.gen(function* () {
          const started = (yield* tool("automation_run", { automationId })) as {
            readonly run: { readonly runId: string };
          };
          yield* cloud.settle;
          return (yield* getRun(started.run.runId)).run;
        });

        // The agent publishing its own draft vouches for nothing.
        yield* tool("automation_publish", { automationId });
        expect((yield* runIt).error).toContain(
          "Only Signalbox's own automations, or one a person published",
        );
        expect(github.pulls[0]).toMatchObject({ merged: false });

        // The person publishes the version they looked at in the app.
        const again = (yield* tool("automation_save", {
          source,
          compiled: compiled.compiled,
          automationId,
          draft: true,
        })) as { readonly automation: { readonly draftVersion: number } };
        yield* rpc[AUTOMATION_WS_METHODS.automationsPublish]({
          automationId,
          version: again.automation.draftVersion,
        });
        expect((yield* runIt).status).toBe("succeeded");
        expect(github.pulls[0]).toMatchObject({ merged: true });
      }),
    );
  });

  it.effect("the gate sees where a fork's pull request comes from and goes (#5)", () => {
    const { cloud, github, open, tool, getRun, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        yield* open;
        github.update(1, { checks: [...PASSED], files: ["app.ts"], headRepository: "fork/repo" });
        yield* cloud.syncPullRequests(threadId);

        const { waitId } = (yield* tool("merge_pull_request", { url: URL })) as {
          readonly waitId: string;
        };
        yield* cloud.settle;
        const read = (yield* getRun(waitId)).steps.find(
          (step) => step.label === "Read the pull request",
        );
        expect(read?.result).toMatchObject({
          headBranch: github.pulls[0]!.head,
          baseBranch: "main",
          headRepository: "fork/repo",
        });
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
