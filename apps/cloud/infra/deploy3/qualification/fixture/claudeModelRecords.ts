import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import type { ClaudeWorkloadRecord } from "./claudeModelTransport.ts";

export interface ClaudePersistedModelRecord extends ClaudeWorkloadRecord {
  readonly artifact?: HarnessRunArtifact;
  readonly runId?: string;
  readonly publicRequestId?: string;
  readonly variant?: "baseline" | "hooks";
  readonly workflowPhase?: "work" | "resume" | "finish";
}
