import { getHarnessReleaseDiscoverySource } from "./harnessReleaseDiscoverySource.ts";
import { getHarnessReleaseEntrySource } from "./harnessReleaseEntrySource.ts";
import { getHarnessReleaseExecutionSource } from "./harnessReleaseExecutionSource.ts";
import { getHarnessReleasePolicySource } from "./harnessReleasePolicySource.ts";

let source: string | undefined;

export const getHarnessReleaseWatchSource = () => {
  if (source === undefined)
    source = `export const meta = {
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

${getHarnessReleasePolicySource()}
${getHarnessReleaseDiscoverySource()}
${getHarnessReleaseExecutionSource()}
${getHarnessReleaseEntrySource()}
`;
  return source;
};
