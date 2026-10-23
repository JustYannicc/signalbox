import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { makeHarness } from "./harnessStateWorkerd.testSupport.ts";

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("keeps older reconciliation retries from touching newer prepared work after DO rehydration", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const prepared = await main.fetch("http://proof/reconciliation-history-prepare");
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toEqual({ prepared: "C", checkpoint: "workerd-checkpoint-1" });

  const runId = "workerd-reconciliation-history-proof";
  await main.evictDurableObject("HarnessFilesStoreObject", { name: runId });
  await main.evictDurableObject("HarnessThreadSupervisorObject", { name: runId });
  const replay = await main.fetch("http://proof/reconciliation-history-replay");
  expect(replay.status).toBe(200);
  const result = (await replay.json()) as { before: unknown; after: unknown } & Record<
    string,
    unknown
  >;
  expect(result).toMatchObject({
    replayEAction: "unchanged",
    replayFAction: "unchanged",
    changedECode: "CONFLICT",
    changedFCode: "CONFLICT",
    blockedReplacementCode: "INDETERMINATE",
    before: {
      preparedFacet: {
        operationId: "history-prepared-c",
        generation: 2,
        facetNonce: "workerd-history-facet-2c",
      },
      lifecycle: "indeterminate",
      checkpoint: { checkpointId: "workerd-checkpoint-1" },
      admittedStepId: null,
      admissionResolution: {
        evidenceId: "history-evidence-f",
        stepId: null,
        outcome: "notApplied",
      },
      activeStepId: null,
      publication: {
        operationId: "history-prepared-c",
        status: "pending",
      },
    },
    cSpecificReconcile: "reconciled",
    replacementAfterC: "prepared",
    receiptGoneAfterC: true,
  });
  expect(result.after).toEqual(result.before);
});
