export const HARNESS_TURN_MILESTONE_TYPE = "harness.turn-milestone" as const;

export const HARNESS_TURN_STAGES = [
  "native-setup",
  "sdk-initializing",
  "cli-spawned",
  "cli-first-stdout-byte",
  "cli-stderr-bytes",
  "control-initialize-sent",
  "control-response-received",
  "runtime-compatibility-checking",
  "runtime-compatibility-confirmed",
  "sdk-initialized",
  "prompt-offered",
  "model-request-sent",
  "first-model-byte",
  "mcp-initializing",
  "mcp-registration-acknowledged",
  "mcp-initialize-response",
  "mcp-initialized",
  "tool-permission-requested",
  "tool-permission-resolved",
  "pre-tool-gate-entered",
  "tool-call-started",
  "tool-call-ended",
] as const;

export type HarnessTurnStage = (typeof HARNESS_TURN_STAGES)[number];

const stageSet: ReadonlySet<string> = new Set(HARNESS_TURN_STAGES);
const MAX_MILESTONE_MESSAGE_LENGTH = 160;

export const encodeHarnessTurnMilestone = (stage: HarnessTurnStage): string =>
  JSON.stringify({ type: HARNESS_TURN_MILESTONE_TYPE, stage });

/** Ignore provider output that is not exactly our small, bounded milestone record. */
export const parseHarnessTurnMilestone = (message: string): HarnessTurnStage | undefined => {
  if (message.length > MAX_MILESTONE_MESSAGE_LENGTH) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "type") ||
    !Object.hasOwn(record, "stage") ||
    record.type !== HARNESS_TURN_MILESTONE_TYPE ||
    typeof record.stage !== "string" ||
    !stageSet.has(record.stage)
  )
    return undefined;

  return record.stage as HarnessTurnStage;
};
