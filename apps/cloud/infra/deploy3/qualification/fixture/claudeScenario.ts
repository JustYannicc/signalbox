export const CLAUDE_PHASES = ["work", "resume", "finish"] as const;
export type ClaudeStepPhase = (typeof CLAUDE_PHASES)[number];
export type ClaudeVariant = "baseline" | "hooks";
export interface ClaudeStep {
  readonly variant: ClaudeVariant;
  readonly requestId: string;
  readonly phase: ClaudeStepPhase;
}
export type ClaudeIncarnation = {
  readonly incarnation: string;
  readonly loaderId: string;
  readonly variant: ClaudeVariant;
} & (
  | { readonly kind: "fresh" }
  | {
      readonly kind: "restored";
      readonly nativeSessionId: string;
      readonly checkpointId: string;
      readonly manifestSha256: string;
    }
);
export const CLAUDE_DEPLOY3_CRITERIA = [
  "boot",
  "text",
  "readEdit",
  "bash",
  "grep",
  "resume",
  "mcp",
  "publicHarness",
] as const;

export function claudeStepRoute(step: ClaudeStep) {
  const suffix =
    step.requestId === `${step.variant}-replace`
      ? "replace"
      : step.requestId === `${step.variant}-stop`
        ? "finish"
        : `turn/${CLAUDE_PHASES.indexOf(step.phase) + 1}`;
  return `/claude/${step.variant}/${suffix}/dispatch`;
}
