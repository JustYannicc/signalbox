import { claudeQualificationColdTimer } from "../claudeWorkload.ts";
import type {
  ColdFirstSuccessfulRpcTimer,
  ColdFirstSuccessfulRpcTiming,
} from "../../../harnessReleases/claudeQualification/contracts.ts";
import { claudeLane, type ClaudeVariant } from "./claudeCTransport.ts";
import type { ClaudeLifecycle } from "./claudeLifecycle.ts";
import { assert } from "./common.ts";
export { collectClaudeModelWorkloadEvidence } from "./claudeModelEvidence.ts";
export type {
  ClaudePersistedModelRecord,
  ClaudeModelWorkloadEvidence,
} from "./claudeModelEvidence.ts";
export { collectCombinedQualification } from "../combinedQualification.ts";

export type ClaudeWorkflowPhase = "work" | "resume" | "finish";
export type ClaudeWorkflowTurnReceipt = Awaited<ReturnType<ClaudeLifecycle["turn"]>>;
export interface ClaudeWorkflowObservation {
  readonly schema: "signalbox/claude-qualification-public-c-workflow/v2";
  readonly purpose: "qualification";
  readonly variant: ClaudeVariant;
  readonly lane: ReturnType<typeof claudeLane>;
  readonly status: "observed";
  readonly qualification: "pending";
  readonly firstPublicCall: "startFreshProcess";
  readonly coldStartupUpperBound: ColdFirstSuccessfulRpcTiming;
  readonly turns: readonly ClaudeWorkflowTurnReceipt[];
  readonly replacement: Awaited<ReturnType<ClaudeLifecycle["replace"]>>;
  readonly completion: Awaited<ReturnType<ClaudeLifecycle["finish"]>>;
}

/** Parent timing encloses fresh creation and the first completed public request, without warmup. */
export async function runClaudeQualificationWorkflow(input: {
  readonly rootRunId: string;
  readonly variant: ClaudeVariant;
  readonly ports: Pick<ClaudeLifecycle, "turn" | "replace" | "finish">;
  readonly timer?: ColdFirstSuccessfulRpcTimer;
}): Promise<ClaudeWorkflowObservation> {
  const measured = await (
    input.timer ?? claudeQualificationColdTimer
  ).measureColdFirstSuccessfulRpc(() => input.ports.turn(1));
  const replacement = await input.ports.replace();
  const second = await input.ports.turn(2);
  const third = await input.ports.turn(3);
  const completion = await input.ports.finish();
  const turns = [measured.value, second, third];
  assert(
    turns.map((turn) => turn.phase).join(",") === "work,resume,finish" &&
      completion.completedTurns === 3 &&
      completion.replacementCount === 1 &&
      completion.ownership.writer === null &&
      completion.ownership.leases === 0,
    "Claude workflow lacks its three completed turns, one replacement and final joins",
  );
  return {
    schema: "signalbox/claude-qualification-public-c-workflow/v2",
    purpose: "qualification",
    variant: input.variant,
    lane: claudeLane(input.rootRunId, input.variant),
    status: "observed",
    qualification: "pending",
    firstPublicCall: "startFreshProcess",
    coldStartupUpperBound: measured.timing,
    turns,
    replacement,
    completion,
  };
}
