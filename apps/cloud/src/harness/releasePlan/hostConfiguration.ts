import * as Schema from "effect/Schema";
import { ReleaseOmissionConfiguration } from "@t3tools/contracts/harnessReleaseOmission";
import { CLAUDE_MEMORY_ENV } from "@t3tools/contracts/harnessMemorySettings";

// These stay dynamic during omission so an explicit SDK env override keeps its native meaning.
export const CLAUDE_HOST_MEMORY_ENV = CLAUDE_MEMORY_ENV;

/** Only values enforced by every host launch may be folded. Caller-owned env stays dynamic. */
export const CLAUDE_HOST_CONFIG = {
  name: "product",
  env: {},
} as const satisfies typeof ReleaseOmissionConfiguration.Type;

export function claudeHostEnvironment(input: Readonly<Record<string, string | undefined>>) {
  const env: Record<string, string | undefined> = { ...CLAUDE_HOST_MEMORY_ENV, ...input };
  const enforced: Readonly<Record<string, string | null>> = CLAUDE_HOST_CONFIG.env;
  for (const [key, value] of Object.entries(enforced)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

const decodeConfiguration = Schema.decodeUnknownSync(ReleaseOmissionConfiguration, {
  onExcessProperty: "error",
});

export const matchesClaudeHostConfiguration = (input: unknown): boolean => {
  let configuration: typeof ReleaseOmissionConfiguration.Type;
  try {
    configuration = decodeConfiguration(input);
  } catch {
    return false;
  }

  const actualPins = Object.entries(configuration.env);
  const enforcedPins = Object.entries(CLAUDE_HOST_CONFIG.env);
  return (
    configuration.name === CLAUDE_HOST_CONFIG.name &&
    actualPins.length === enforcedPins.length &&
    enforcedPins.every(([key, value]) => configuration.env[key] === value)
  );
};
