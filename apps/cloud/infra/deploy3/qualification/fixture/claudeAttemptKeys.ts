// Keep producer keys independent of the exporter's runtime Schema decoders.
export const CLAUDE_REQUEST_ATTEMPTS_KEY = "claude/request-attempt-counters";
export const CLAUDE_REQUEST_ATTEMPTS_PREFIX = "claude/request-attempt/";

export function claudeRequestAttemptKey(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1)
    throw new RangeError("Claude request attempt ordinal is invalid.");
  return `${CLAUDE_REQUEST_ATTEMPTS_PREFIX}${String(ordinal).padStart(10, "0")}`;
}
