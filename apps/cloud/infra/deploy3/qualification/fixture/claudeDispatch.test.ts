import { expect, it } from "vite-plus/test";
import { ClaudeDispatch } from "./claudeDispatch.ts";
import type { QualifierExecutionContext } from "./proofContext.ts";

const ready = { ready: true, "observer/claude-calibration": { status: "passed" } };
const claimReached = new Error("claim reached");

/** Runs the claim transaction over `records`, stopping at the first write. */
const dispatchWith = (records: Record<string, unknown>) =>
  new ClaudeDispatch(
    {} as QualifierExecutionContext,
    {
      get: async (key: string) => records[key],
      transaction: async (run: (tx: DurableObjectTransaction) => Promise<unknown>) =>
        run({
          get: async (key: string) => records[key],
          put: async () => {
            throw claimReached;
          },
        } as unknown as DurableObjectTransaction),
    } as unknown as DurableObjectStorage,
    "incarnation",
  ).dispatch();

it("lets Claude dispatch proceed on its own calibration and never on the Codex one", async () => {
  await expect(
    dispatchWith({ ready: true, "observer/calibration": { status: "passed" } }),
  ).rejects.toThrow("The Claude observer calibration must precede Claude native dispatch");
  await expect(dispatchWith(ready)).rejects.toBe(claimReached);
});

it("refuses the thread step while any Codex claim could report native commands", async () => {
  await expect(dispatchWith({ ...ready, "execution-owner": "codex" })).rejects.toThrow(
    "A Codex native sequence owns this proof",
  );
  await expect(dispatchWith({ ...ready, "observer/calibration-claimed": true })).rejects.toThrow(
    "The Codex observer calibration is still running",
  );
  await expect(
    dispatchWith({ ...ready, "sequence/lifetime-claim": { phase: "held" } }),
  ).rejects.toThrow("The Codex sequence is held");
  // A finished calibration and a released sequence are idle.
  await expect(
    dispatchWith({
      ...ready,
      "observer/calibration-claimed": true,
      "observer/calibration": { status: "passed" },
      "sequence/lifetime-claim": { phase: "released" },
    }),
  ).rejects.toBe(claimReached);
});
