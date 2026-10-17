import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePullRequestThread } from "../automations/pullRequestThreadTesting.ts";
import { signedBody } from "../automations/hookTesting.ts";
import { GitHubWebhooks } from "./GitHubWebhooks.ts";

describe("GitHub check transitions", () => {
  it.effect.each([
    { conclusion: "SUCCESS", event: "pr.checks.passed" },
    { conclusion: "FAILURE", event: "pr.checks.failed" },
  ] as const)(
    "delivers $event again for a new head with the same check result",
    ({ conclusion, event }) => {
      const { cloud, github, open, run, tool } = makePullRequestThread();
      return Effect.gen(function* () {
        yield* open;
        github.update(1, { checks: [{ name: "CI", status: "COMPLETED", conclusion }] });
        const source = `export const meta = { name: "Check transitions", overlap: "allow", triggers: [{ on: "${event}", where: { repository: "owner/repo" } }] } as const;
export default workflow(async (_w, pr: unknown) => pr);`;
        const compiled = compileForCloud(source);
        if (!compiled.ok) return yield* Effect.die(compiled.diagnostics);
        const saved = (yield* tool("automation_save", { source, compiled: compiled.compiled })) as {
          automation: { automationId: string };
        };
        const subscription = (yield* cloud.inUser(
          "user_1",
          GitHubWebhooks.use((hooks) => hooks.store.list),
        ))[0]!;
        const branch = github.pulls[0]!.head;
        const firstHead = github.head(branch)!;
        const deliver = (sha: string, deliveryId: string) =>
          Effect.gen(function* () {
            const body = JSON.stringify({
              action: "completed",
              repository: { full_name: "owner/repo" },
              check_suite: { head_sha: sha, pull_requests: [{ number: 1 }] },
            });
            const signature = yield* Effect.promise(() => signedBody(body, subscription.secret));
            expect(
              yield* cloud.userDirectory.forUser("user_1").receiveHook({
                hookId: subscription.id,
                token: "",
                method: "POST",
                query: "",
                body: new TextEncoder().encode(body),
                headers: {
                  "x-github-event": "check_suite",
                  "x-github-delivery": deliveryId,
                  "x-hub-signature-256": signature,
                },
              }),
            ).toMatchObject({ status: 202 });
            yield* cloud.fireAlarm("user_1");
            yield* cloud.settle;
            return yield* cloud.inUser(
              "user_1",
              WorkflowEngine.use((engine) => engine.get(saved.automation.automationId)),
            );
          });

        expect((yield* deliver(firstHead, "head-a")).runs).toHaveLength(1);
        expect((yield* deliver(firstHead, "head-a-another-check")).runs).toHaveLength(1);
        github.pushEmptyCommit(branch);
        const secondHead = github.head(branch)!;
        expect(secondHead).not.toBe(firstHead);
        expect((yield* deliver(firstHead, "stale-head-a")).runs).toHaveLength(1);
        const detail = yield* deliver(secondHead, "head-b");
        expect(detail.runs).toHaveLength(2);
        const outputs = yield* cloud.inUser(
          "user_1",
          WorkflowEngine.use((engine) =>
            Effect.forEach(detail.runs, (entry) => engine.getRun(entry.id)),
          ),
        );
        expect(outputs.every(({ run }) => run.status === "succeeded")).toBe(true);
        expect(outputs.map(({ output }) => output)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event, headSha: firstHead }),
            expect.objectContaining({ event, headSha: secondHead }),
          ]),
        );
      }).pipe(run);
    },
  );
});
