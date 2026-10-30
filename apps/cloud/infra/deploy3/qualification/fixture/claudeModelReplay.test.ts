import { expect, it } from "vite-plus/test";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import type { ClaudePersistedModelRecord } from "./claudeModelEvidence.ts";
import { CLAUDE_QUALIFICATION_PROMPTS, ClaudeQualificationModelPeer } from "./claudeModelPeer.ts";
import { replayClaudeModel } from "./claudeModelReplay.ts";
import { createClaudeWorkloadTransport } from "./claudeModelTransport.ts";
import { sha256 } from "./common.ts";

async function capturedExchange() {
  const identity = {
    model: "claude-sonnet-4-6",
    collectorNonce: "replay-test",
    mcpProbe: {
      toolName: "mcp__executor__qualification_echo",
      input: { text: "probe" },
      expectedText: "probe",
    },
  };
  const peer = new ClaudeQualificationModelPeer(identity);
  const records: ClaudePersistedModelRecord[] = [];
  const wires = new Map<string, Uint8Array>();
  const transport = createClaudeWorkloadTransport({
    ...identity,
    apiRevision: "EC1APIr2",
    fetch: (request) => peer.fetch(request),
    modelEvidence: () => peer.snapshot(),
    record: async (record, wire) => {
      if (!wire) throw new Error("Expected retained wire bytes");
      const artifact = {
        id: `wire-${records.length}`,
        bytes: wire.byteLength,
        sha256: await sha256(wire),
      };
      wires.set(artifact.id, wire.slice());
      records.push({ ...record, artifact });
    },
  });
  await transport(
    new Request("https://model.invalid/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: identity.model,
        max_tokens: 128,
        messages: [{ role: "user", content: CLAUDE_QUALIFICATION_PROMPTS.resume }],
      }),
    }),
  );
  const [request, terminal] = records;
  if (!request || !terminal) throw new Error("Missing captured exchange");
  const readArtifact = async (reference: HarnessRunArtifact) => {
    const wire = wires.get(reference.id);
    if (!wire) throw new Error("Missing retained wire");
    return wire.slice();
  };
  return { identity, request, terminal, wires, readArtifact };
}

it("reconstructs model state from retained request and response bytes", async () => {
  const captured = await capturedExchange();
  await expect(
    replayClaudeModel({
      ...captured.identity,
      exchanges: [{ request: captured.request, terminal: captured.terminal }],
      readArtifact: captured.readArtifact,
    }),
  ).resolves.toMatchObject({ resumeCompleted: true, workCompleted: false });
});

it("rejects forged model counters even when the retained response is unchanged", async () => {
  const captured = await capturedExchange();
  await expect(
    replayClaudeModel({
      ...captured.identity,
      exchanges: [
        { request: captured.request, terminal: { ...captured.terminal, modelEvidence: {} } },
      ],
      readArtifact: captured.readArtifact,
    }),
  ).rejects.toThrow("CLAUDE_MODEL_REPLAY_SNAPSHOT_MISMATCH");
});

it("rejects changed response bytes even when the reported model state is unchanged", async () => {
  const captured = await capturedExchange();
  if (!captured.terminal.artifact) throw new Error("Missing response artifact");
  captured.wires.set(captured.terminal.artifact.id, new TextEncoder().encode("{}"));
  await expect(
    replayClaudeModel({
      ...captured.identity,
      exchanges: [{ request: captured.request, terminal: captured.terminal }],
      readArtifact: captured.readArtifact,
    }),
  ).rejects.toThrow("CLAUDE_MODEL_REPLAY_RESPONSE_MISMATCH");
});
