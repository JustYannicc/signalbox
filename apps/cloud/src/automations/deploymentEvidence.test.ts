import { AuthOrchestrationReadScope, AUTOMATION_WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePullRequestThread, threadId } from "./pullRequestThreadTesting.ts";

const url = "https://github.test/owner/repo/pull/1";

describe("deployment evidence access", () => {
  it.effect("serves the actual merge through read-only RPC and the generated agent API", () => {
    const { github, open, api, run } = makePullRequestThread();
    return run(
      Effect.gen(function* () {
        const { rpc, turn } = yield* open;
        github.merge(1);
        expect(
          yield* rpc[AUTOMATION_WS_METHODS.automationsDeploymentEvidence]({ threadId, url }),
        ).toEqual({ commit: turn, baseBranch: "main", run: null });
        expect(
          yield* api("automations.deploymentEvidence", { threadId, url }, "agent", [
            AuthOrchestrationReadScope,
          ]),
        ).toMatchObject({ status: 200, body: { commit: turn, run: null } });
        expect(
          yield* api("automations.deploymentEvidence", { threadId, url }, "agent", []),
        ).toMatchObject({
          status: 403,
          body: { error: { requiredScope: AuthOrchestrationReadScope } },
        });
      }),
    );
  });

  it.effect(
    "refuses an unmerged PR, unlinked repository, missing thread and malformed run id",
    () => {
      const { open, api, run } = makePullRequestThread();
      return run(
        Effect.gen(function* () {
          yield* open;
          for (const input of [
            { threadId, url },
            { threadId, url: "https://github.test/another/repository/pull/1" },
            { threadId: "missing-thread", url },
          ]) {
            expect(yield* api("automations.deploymentEvidence", input, "agent")).toMatchObject({
              status: 422,
            });
          }
          expect(
            yield* api(
              "automations.deploymentEvidence",
              { threadId, url, runId: "../123" },
              "agent",
            ),
          ).toMatchObject({ status: 400 });
        }),
      );
    },
  );
});
