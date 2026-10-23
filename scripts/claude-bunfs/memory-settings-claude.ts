import {
  CLAUDE_MEMORY_DEFAULT_ENV,
  CLAUDE_MEMORY_RETENTION_ENV,
} from "@t3tools/contracts/harnessMemorySettings";
import {
  inspectClaudeMemoryRetentionSources,
  inspectClaudeMemorySettingSources,
} from "./memory-settings-claude-source.ts";

export interface ClaudeMemorySettingDefaultEvidence {
  readonly key: string;
  readonly source: string;
  readonly default: string;
}

export interface ClaudeMemorySettingRetentionEvidence {
  readonly key: string;
  readonly source: string;
  readonly mode: "retention";
  readonly explicitValue: string;
}

export type ClaudeMemorySettingEvidence =
  | ClaudeMemorySettingDefaultEvidence
  | ClaudeMemorySettingRetentionEvidence;

export function assertClaudeMemorySettings(
  sources: ReadonlyMap<string, string>,
  pins: Readonly<Record<string, string>>,
): ClaudeMemorySettingEvidence[] {
  const defaults: Record<string, string> = {};
  const retention: Record<string, string> = {};
  for (const [key, value] of Object.entries(pins)) {
    if (Object.hasOwn(CLAUDE_MEMORY_DEFAULT_ENV, key)) defaults[key] = value;
    else if (Object.hasOwn(CLAUDE_MEMORY_RETENTION_ENV, key)) retention[key] = value;
    else throw new Error(`RELEASE_MEMORY_SETTING_UNSUPPORTED: ${key}`);
  }

  const defaultEvidence = inspectClaudeMemorySettingSources(sources, defaults).map(
    ({ key, source, default: nativeDefault, changed }) => {
      if (!source) throw new Error(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
      if (changed || (nativeDefault !== undefined && nativeDefault !== defaults[key]))
        throw new Error(`RELEASE_MEMORY_SETTING_DEFAULT_CHANGED: ${key}`);
      if (nativeDefault === undefined)
        throw new Error(`RELEASE_MEMORY_SETTING_DEFAULT_UNPROVEN: ${key}`);
      return { key, source, default: nativeDefault };
    },
  );

  const retentionEvidence = inspectClaudeMemoryRetentionSources(sources, retention).map(
    ({ key, source, explicitValue, honored }) => {
      if (!source) throw new Error(`RELEASE_MEMORY_SETTING_MISSING: ${key}`);
      if (
        explicitValue !==
        CLAUDE_MEMORY_RETENTION_ENV[key as keyof typeof CLAUDE_MEMORY_RETENTION_ENV]
      )
        throw new Error(`RELEASE_MEMORY_SETTING_RETENTION_CHANGED: ${key}`);
      if (!honored) throw new Error(`RELEASE_MEMORY_SETTING_RETENTION_UNPROVEN: ${key}`);
      return { key, source, mode: "retention" as const, explicitValue };
    },
  );
  return [...defaultEvidence, ...retentionEvidence];
}
