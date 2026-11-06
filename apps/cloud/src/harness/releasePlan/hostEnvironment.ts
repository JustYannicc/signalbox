import type { ReleaseOmissionConfiguration } from "@t3tools/contracts/harnessReleaseOmission";

/** Only values enforced by every host launch may be folded. Caller-owned env stays dynamic. */
export const CLAUDE_HOST_CONFIG = {
  name: "product",
  env: {},
} as const satisfies typeof ReleaseOmissionConfiguration.Type;
