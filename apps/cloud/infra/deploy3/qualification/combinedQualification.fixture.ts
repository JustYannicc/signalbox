import type { collectCombinedQualification } from "./combinedQualification.ts";
import { CLAUDE_THREAD_ROUTE } from "./fixture/claudeDispatch.ts";

/** A completed Codex sequence and Claude thread step, as their exported receipts record them. */
export function combinedEvidenceFixture() {
  const runId = "00000000-0000-4000-8000-000000000001";
  const model = "synthetic-model";
  const collectorNonce = "synthetic-collector";
  const tool = (name: string, resultText: string) => ({
    ordinal: 1,
    name,
    toolUseId: `toolu_${name}`,
    resultText,
  });
  const input = {
    runId,
    classification: "synthetic",
    collectorNonce,
    model,
    codex: {
      completedTurns: 3,
      replacementCount: 1,
      nativeSessionId: "codex-native",
      model: { complete: { completedTurns: 3, replacements: 1, nativeSessionId: "codex-native" } },
      ownership: { writer: null, leases: 0 },
      evidence: {
        terminal: [1, 2, 3].map(() => ({
          value: {
            nativeSessionId: "codex-native",
            stopped: true,
            joined: { invocationRpc: true, fetch: true, ports: true },
          },
        })),
      },
    },
    claude: {
      receipt: {
        schema: "signalbox/claude-qualification-thread/v1",
        runId,
        status: "completed",
        result: {
          completed: true,
          turns: [
            { runId: "run-1", status: "completed" },
            { runId: "run-2", status: "completed" },
          ],
          model: {
            purpose: "qualification",
            collectorNonce,
            model,
            requests: 6,
            workCompleted: true,
            resumeCompleted: true,
            toolEvidence: [
              tool("Read", "needle=sb1070"),
              tool("Grep", "/workspace/file.txt:2:needle=sb1070"),
            ],
          },
        },
      },
      kernelInvocations: [
        {
          runId,
          invocationId: "thread-grep",
          route: { method: "POST", path: CLAUDE_THREAD_ROUTE },
          executable: "/bin/rg",
          argv: ["rg", "needle", "/workspace/file.txt"],
          exit: { exitCode: 0, signal: 0, coreDumped: false },
        },
      ],
    },
  };
  // The Codex receipt carries only the fields the collector reads.
  return input as unknown as Parameters<typeof collectCombinedQualification>[0];
}
