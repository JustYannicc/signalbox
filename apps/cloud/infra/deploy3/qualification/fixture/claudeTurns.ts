import { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { CLAUDE_QUALIFICATION_PROMPTS } from "./claudeModelPeer.ts";

/** Deterministic input templates only; native identity is bound from public fresh creation before dispatch. */
export function claudeQualificationTurns(
  base: RunnerTurn,
  variant: "baseline" | "hooks",
): readonly RunnerTurn[] {
  if (base.providerThread.driver !== "claudeAgent")
    throw new Error("DEPLOY3_CLAUDE_TURN_PROVIDER_MISMATCH");
  return (["work", "resume", "finish"] as const).map((phase, index) => ({
    ...base,
    runId: RunId.make(`${base.runId}/claude-qualification/${variant}/${phase}`),
    attemptId: RunAttemptId.make(`${base.attemptId}/claude-qualification/${variant}/${phase}`),
    runOrdinal: base.runOrdinal + index,
    providerTurnOrdinal: base.providerTurnOrdinal + index,
    message: {
      ...base.message,
      messageId: MessageId.make(
        `${base.message.messageId}/claude-qualification/${variant}/${phase}`,
      ),
      text: CLAUDE_QUALIFICATION_PROMPTS[phase],
      attachments: [],
    },
  }));
}
