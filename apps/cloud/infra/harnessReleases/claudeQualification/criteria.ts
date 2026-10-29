export const RELEASE_CRITERIA = [
  "boot",
  "text",
  "readEdit",
  "bash",
  "grep",
  "resume",
  "mcp",
  "interrupt",
  "publicHarness",
] as const;

export type ReleaseCriterion = (typeof RELEASE_CRITERIA)[number];
