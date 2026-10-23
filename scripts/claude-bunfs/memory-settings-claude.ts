import { inspectClaudeMemorySettingSources } from "./memory-settings-claude-source.ts";

export interface ClaudeMemorySettingEvidence {
  readonly key: string;
  readonly source: string;
  readonly default: string;
}

export function assertClaudeMemorySettings(
  sources: ReadonlyMap<string, string>,
  pins: Readonly<Record<string, string>>,
): ClaudeMemorySettingEvidence[] {
  const evidence = inspectClaudeMemorySettingSources(sources, pins);
  return evidence.map(({ key, source, default: nativeDefault }) => {
    if (!source) throw new Error(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
    if (evidence.find((entry) => entry.key === key)?.changed)
      throw new Error(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
    if (nativeDefault === undefined)
      throw new Error(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`);
    if (nativeDefault !== pins[key])
      throw new Error(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
    return { key, source, default: nativeDefault };
  });
}
