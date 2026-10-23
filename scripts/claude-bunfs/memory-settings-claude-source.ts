import { ClaudeEnvironmentOrigin } from "./memory-settings-claude-environment.ts";
import { ClaudeDefaultEvaluator } from "./memory-settings-claude-default.ts";
import type { ClaudeSettingEvidence } from "./memory-settings-claude-default.ts";
import { ClaudeSourceGraph } from "./memory-settings-claude-graph.ts";

export type ClaudeMemorySettingSourceEvidence = ClaudeSettingEvidence;

export function inspectClaudeMemorySettingSources(
  sources: ReadonlyMap<string, string>,
  pins: Readonly<Record<string, string>>,
): ClaudeMemorySettingSourceEvidence[] {
  const graph = new ClaudeSourceGraph(sources);
  const environment = new ClaudeEnvironmentOrigin(graph);
  return new ClaudeDefaultEvaluator(graph, environment).inspect(pins);
}
