import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { CombinedFixtureInput } from "./bundleInput.ts";
import { CLAUDE_QUALIFICATION_PROMPTS } from "./fixture/claudeModelPeer.ts";
const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));

/** Native UUIDs are issued by public fresh creation; frozen inputs may contain no seed identity. */
export function validateClaudeFixtureTurns(
  runtime: (typeof CombinedFixtureInput.Type)["claudeRuntime"],
) {
  const prompts = (["work", "resume", "finish"] as const).map(
    (phase) => CLAUDE_QUALIFICATION_PROMPTS[phase],
  );
  const allTurns = [];
  for (const variant of ["baseline", "hooks"] as const) {
    const encodedTurns = runtime.turnJson[variant];
    if (encodedTurns.length !== prompts.length)
      throw new Error("DEPLOY3_CLAUDE_WORKLOAD_TURNS_REQUIRED");
    const turns = encodedTurns.map((encoded) => decodeTurn(encoded));
    const initial = turns[0]!;
    for (const [index, turn] of turns.entries()) {
      if (
        turn.providerThread.driver !== "claudeAgent" ||
        turn.modelSelection.model !== runtime.model ||
        turn.modelSelection.instanceId !== initial.modelSelection.instanceId ||
        turn.threadId !== initial.threadId ||
        turn.providerThread.id !== initial.providerThread.id ||
        turn.providerThread.providerSessionId !== initial.providerThread.providerSessionId ||
        turn.message.text !== prompts[index] ||
        turn.providerThread.nativeThreadRef !== null
      )
        throw new Error("DEPLOY3_CLAUDE_TURN_IDENTITY_MISMATCH");
    }
    allTurns.push(...turns);
  }
  for (const identities of [
    allTurns.map((turn) => turn.runId),
    allTurns.map((turn) => turn.attemptId),
    allTurns.map((turn) => turn.message.messageId),
  ])
    if (new Set(identities.map(String)).size !== allTurns.length)
      throw new Error("DEPLOY3_CLAUDE_TURN_IDENTITY_REUSED");
}
