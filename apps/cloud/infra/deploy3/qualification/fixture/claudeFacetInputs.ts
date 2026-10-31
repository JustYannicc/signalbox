import type { Configuration } from "./configuration.ts";
import { claudeLane, type ClaudeVariant } from "./claudeScenario.ts";

type ClaudeConfiguration = Pick<Configuration, "runId" | "claude">;
export const claudeBootstrap = (config: ClaudeConfiguration, variant: ClaudeVariant) => ({
  provider: "claude-code" as const,
  preparedReleaseId: config.claude.expected[variant].artifact.releaseId,
  restoreMode: "same-variant-serialized-checkpoint" as const,
});
export const claudeFacet = (config: ClaudeConfiguration, variant: ClaudeVariant) => ({
  processId: claudeLane(config.runId, variant).processId,
  codeId: config.claude.expected[variant].artifact.releaseId,
  residentBytes: 104 * 1024 * 1024,
  mainModule: "qualifier-claude-facet.mjs",
  entrypoint: "ClaudeFacet",
  modules: {
    "qualifier-claude-facet.mjs": {
      js: "export { ClaudeFacet } from './qualifier-claude-implementation.mjs';\n",
    },
  },
  facetEnv: { QUALIFIER_CLAUDE_VARIANT: variant },
});
