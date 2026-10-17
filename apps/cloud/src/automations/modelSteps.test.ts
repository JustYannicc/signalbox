import { AUTOMATION_WS_METHODS, ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Scripted from "../thread/scriptedProvider.ts";
import { hookTestSetup } from "./hookTesting.ts";

afterEach(() => vi.restoreAllMocks());

describe("cloud model steps", () => {
  it.effect(
    "judge, extract and llm run on the saved model in plan-mode threads and return their values",
    () =>
      Effect.gen(function* () {
        const original = Scripted.scriptedReply;
        vi.spyOn(Scripted, "scriptedReply").mockImplementation((prompt) =>
          prompt.includes("Answer with exactly one of:")
            ? "bug"
            : prompt.startsWith("Extract the following")
              ? '{"number":42,"ready":true}'
              : prompt.startsWith("Summarize")
                ? "PR 42 is ready"
                : original(prompt),
        );
        const { cloud, save, rpc, engine } = yield* hookTestSetup();
        const automation = yield* save(`export const meta = { name: "Cloud models" } as const;
export default workflow(async (w) => {
  const kind = await w.judge("Bug or noise?", { input: "Login crashes", outcomes: ["bug", "noise"] });
  const pr = await w.extract("Read the PR", { input: "PR 42 ready", schema: { number: "number", ready: "boolean" } });
  const text = await w.llm("Summarize it", { prompt: "Summarize this PR", input: pr });
  return { kind, pr, text };
});`);
        const run = yield* rpc[AUTOMATION_WS_METHODS.automationsRunNow]({
          automationId: automation.id,
        });
        yield* cloud.settle;
        const done = yield* engine((engine) => engine.getRun(run.id));
        expect([done.run.status, done.output]).toEqual([
          "succeeded",
          { kind: "bug", pr: { number: 42, ready: true }, text: "PR 42 is ready" },
        ]);
        for (const step of done.steps) {
          if (!step.threadId) continue;
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make(step.threadId),
          });
          expect(projection.thread.modelSelection).toEqual(Scripted.scriptedModelSelection);
          expect(projection.thread.interactionMode).toBe("plan");
          expect(projection.thread.projectId).toBe(automation.projectId);
        }
      }),
  );
});
