import type { ColdFirstSuccessfulRpcTiming } from "../../../harnessReleases/claudeQualification/contracts.ts";
import type { claudeLane, ClaudeVariant } from "./claudeCTransport.ts";
import type { ClaudeLifecycle } from "./claudeLifecycle.ts";

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
