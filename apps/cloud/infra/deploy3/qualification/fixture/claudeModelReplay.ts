import type { ClaudeMcpProbe } from "./claudeMcpProbe.ts";
import { ClaudeQualificationModelPeer } from "./claudeModelPeer.ts";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import type { ClaudePersistedModelRecord } from "./claudeModelEvidence.ts";
import { sameData } from "../../../../src/harness/processResume/checkpointContract.ts";

/** Replays retained wire bytes; a peer's self-reported counters cannot replace its tool results. */
export async function replayClaudeModel(input: {
  readonly model: string;
  readonly collectorNonce: string;
  readonly mcpProbe: ClaudeMcpProbe;
  readonly exchanges: readonly {
    readonly request: ClaudePersistedModelRecord;
    readonly terminal: ClaudePersistedModelRecord;
  }[];
  readonly readArtifact: (reference: HarnessRunArtifact) => Promise<Uint8Array>;
}) {
  const peer = new ClaudeQualificationModelPeer(input);
  for (const { request, terminal } of input.exchanges) {
    if (!request.artifact) throw new Error("CLAUDE_MODEL_REPLAY_REQUEST_MISSING");
    const bytes = await input.readArtifact(request.artifact);
    const controller = new AbortController();
    if (terminal.phase === "failure" && terminal.failure === "aborted") controller.abort();
    const invoke = () =>
      peer.fetch(
        new Request(`https://model.invalid${request.path}`, {
          method: request.method,
          body: bytes.slice().buffer,
          signal: controller.signal,
          headers: { "content-type": "application/json" },
        }),
      );
    if (terminal.phase === "failure") {
      let failure: unknown;
      try {
        await invoke();
      } catch (cause) {
        failure = cause;
      }
      if (!(failure instanceof DOMException) || failure.name !== "AbortError")
        throw new Error("CLAUDE_MODEL_REPLAY_INTERRUPT_MISMATCH");
    } else {
      if (!terminal.artifact) throw new Error("CLAUDE_MODEL_REPLAY_RESPONSE_MISSING");
      const predicted = new Uint8Array(await (await invoke()).arrayBuffer());
      const actual = await input.readArtifact(terminal.artifact);
      if (!sameData(predicted, actual)) throw new Error("CLAUDE_MODEL_REPLAY_RESPONSE_MISMATCH");
    }
    if (!sameData(peer.snapshot(), terminal.modelEvidence))
      throw new Error("CLAUDE_MODEL_REPLAY_SNAPSHOT_MISMATCH");
  }
  return peer.snapshot();
}
