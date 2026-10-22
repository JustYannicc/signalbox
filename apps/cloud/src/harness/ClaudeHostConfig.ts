// The host configuration lives beside the release plan, which is private to the harness module.
// Infra publishing and proof hosts reach it through this root entry.
export {
  CLAUDE_HOST_CONFIG,
  matchesClaudeHostConfiguration,
} from "./releasePlan/hostConfiguration.ts";
