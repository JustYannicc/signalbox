import { HARNESS_RELEASE_DISCOVERY_SOURCE } from "./harnessReleaseDiscoverySource.ts";
import { HARNESS_RELEASE_ENTRY_SOURCE } from "./harnessReleaseEntrySource.ts";
import { HARNESS_RELEASE_EXECUTION_SOURCE } from "./harnessReleaseExecutionSource.ts";
import { HARNESS_RELEASE_POLICY_SOURCE } from "./harnessReleasePolicySource.ts";

export const HARNESS_RELEASE_WATCH = `export const meta = {
  name: "Watch harness releases",
  description: "Checks current Claude Code, Claude Agent SDK and Codex releases, then works through a bounded historical set. Run builtin:harness-release-watch once with the Signalbox project's ID to install its hourly trigger in that project.",
  intent: "keep the selected agent harness release backed by exact current-release proof",
  triggers: [{ cron: "0 * * * *", timezone: "Europe/Zurich" }],
  overlap: "skip",
} as const;

type Provider = "claude-code" | "claude-agent-sdk" | "codex";
type Selection = "current" | "backfill";
type Candidate = {
  id: string;
  provider: Provider;
  version: string;
  upstreamIdentity: string;
  selection: Selection;
  provenance: Record<string, unknown>;
};

${HARNESS_RELEASE_POLICY_SOURCE}
${HARNESS_RELEASE_DISCOVERY_SOURCE}
${HARNESS_RELEASE_EXECUTION_SOURCE}
${HARNESS_RELEASE_ENTRY_SOURCE}
`;
