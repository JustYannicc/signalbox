import { expect, it } from "vite-plus/test";
import { collectCombinedQualification } from "./combinedQualification.ts";
import { combinedEvidenceFixture } from "./combinedQualification.fixture.ts";

it("joins both Claude variants and Codex without promoting synthetic evidence", async () => {
  const result = await collectCombinedQualification(await combinedEvidenceFixture());
  expect(result.qualification).toBe("pending");
  expect(result.deploymentReady).toBe(false);
  expect(result.claude.baseline.model.toolResults.map((item) => item.name)).toEqual([
    "Write",
    "Read",
    "Edit",
    "Bash",
    "Grep",
    "mcp__executor__qualification_echo",
  ]);
  expect(result.claude.hooks.workload.moduleInitNonce.same).toBe(true);
  expect(result.claude.baseline.criteria.map((item) => item.name)).not.toContain("interrupt");
  expect(result.claude.baseline.workflow.turns).toHaveLength(3);
  expect(result.claude.baseline.workflow.completion.replacementCount).toBe(1);
});

it("rejects model records copied from another public request", async () => {
  const input = await combinedEvidenceFixture();
  const records = input.claude.baseline.modelRecords.map((record) => ({
    ...record,
    publicRequestId: "another-request",
  }));
  await expect(
    collectCombinedQualification({
      ...input,
      claude: { ...input.claude, baseline: { ...input.claude.baseline, modelRecords: records } },
    }),
  ).rejects.toThrow("MODEL_PUBLIC_BINDING_MISMATCH");
});

it("rejects unrelated C checkpoint receipts and changed nonces", async () => {
  const input = await combinedEvidenceFixture();
  const source = input.claude.baseline;
  const changed = {
    ...source,
    workflow: { ...source.workflow, lane: { ...source.workflow.lane, runId: "another-run" } },
  };
  await expect(
    collectCombinedQualification({ ...input, claude: { ...input.claude, baseline: changed } }),
  ).rejects.toThrow("WORKFLOW_IDENTITY_INVALID");
  await expect(
    collectCombinedQualification({
      ...input,
      claude: {
        ...input.claude,
        baseline: {
          ...source,
          workload: { ...source.workload, moduleInitNonceAfter: "recycled-isolate" },
        },
      },
    }),
  ).rejects.toThrow("NONCE_CHANGED");
});

it("rejects missing final joins and an unchanged replacement identity", async () => {
  const input = await combinedEvidenceFixture();
  const baseline = input.claude.baseline;
  await expect(
    collectCombinedQualification({
      ...input,
      claude: {
        ...input.claude,
        baseline: {
          ...baseline,
          workflow: {
            ...baseline.workflow,
            completion: {
              ...baseline.workflow.completion,
              ownership: { ...baseline.workflow.completion.ownership, leases: 1 },
            },
          },
        },
      },
    }),
  ).rejects.toThrow("WORKFLOW_IDENTITY_INVALID");
  const firstIdentity = baseline.workflow.turns[0]!.shard.processes[0]!.identity!;
  await expect(
    collectCombinedQualification({
      ...input,
      claude: {
        ...input.claude,
        baseline: {
          ...baseline,
          workflow: {
            ...baseline.workflow,
            replacement: {
              ...baseline.workflow.replacement,
              resumed: { ...baseline.workflow.replacement.resumed, identity: firstIdentity },
            },
          },
        },
      },
    }),
  ).rejects.toThrow("WORKFLOW_IDENTITY_INVALID");
});
