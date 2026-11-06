import { expect, it } from "vite-plus/test";
import { ClaudeDispatch } from "./claudeDispatch.ts";
import type { QualifierExecutionContext } from "./proofContext.ts";

it("lets Claude dispatch proceed on its own calibration and never on the Codex one", async () => {
  const claimReached = new Error("claim reached");
  const dispatchWith = (records: Record<string, unknown>) =>
    new ClaudeDispatch(
      {} as QualifierExecutionContext,
      {
        get: async (key: string) => records[key],
        transaction: async () => {
          throw claimReached;
        },
      } as unknown as DurableObjectStorage,
      "incarnation",
    ).dispatch("baseline", "turn-1");

  await expect(
    dispatchWith({ ready: true, "observer/calibration": { status: "passed" } }),
  ).rejects.toThrow("The Claude observer calibration must precede Claude native dispatch");
  await expect(
    dispatchWith({ ready: true, "observer/claude-calibration": { status: "passed" } }),
  ).rejects.toBe(claimReached);
});
