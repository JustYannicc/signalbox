import * as Schema from "effect/Schema";
import { ReleaseOmissionConfiguration } from "@t3tools/contracts/harnessReleaseOmission";

/** Only values enforced by every host launch may be folded. Caller-owned env stays dynamic. */
export const CLAUDE_HOST_CONFIG = {
  name: "product",
  env: {},
} as const satisfies typeof ReleaseOmissionConfiguration.Type;

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
