import { expect, it } from "vite-plus/test";
import { collectCombinedQualification } from "./combinedQualification.ts";
import { combinedEvidenceFixture } from "./combinedQualification.fixture.ts";

it("joins Codex and the Claude thread step without promoting synthetic evidence", async () => {
  const result = await collectCombinedQualification(combinedEvidenceFixture());
  expect(result.qualification).toBe("pending");
  expect(result.deploymentReady).toBe(false);
  expect(result.claude.runs).toEqual(["run-1", "run-2"]);
  expect(result.claude.tools).toEqual(["Read", "Grep"]);
  expect(result.claude.kernelGrep).toBe("thread-grep");
});

it("rejects a failed or retired-lane Claude receipt", async () => {
  const input = combinedEvidenceFixture();
  const receipt = input.claude.receipt as Record<string, unknown>;
  for (const changed of [
    { ...receipt, status: "failed" },
    { ...receipt, schema: "signalbox/claude-qualification-step/v1" },
    { ...receipt, runId: "another-run" },
  ])
    await expect(
      collectCombinedQualification({ ...input, claude: { ...input.claude, receipt: changed } }),
    ).rejects.toThrow();
});

it("requires a successful kernel ripgrep invocation under the Claude thread route", async () => {
  const input = combinedEvidenceFixture();
  const [grep] = input.claude.kernelInvocations as Record<string, unknown>[];
  for (const kernelInvocations of [
    [],
    [{ ...grep, route: { method: "POST", path: "/claude/baseline/turn/1/dispatch" } }],
    [{ ...grep, exit: { exitCode: 2 } }],
    [{ ...grep, runId: "another-run" }],
  ])
    await expect(
      collectCombinedQualification({ ...input, claude: { ...input.claude, kernelInvocations } }),
    ).rejects.toThrow("DEPLOY3_COMBINED_CLAUDE_THREAD_INVALID");
});
