/**
 * Automation tools marked Tool.Readonly, which Claude may call in a read-only
 * sandbox. Kept as plain names so the adapter needn't import the toolkit;
 * ClaudeAdapterV2.test.ts checks the list against the annotations.
 */
export const AUTOMATION_READ_ONLY_TOOLS = [
  "automation_reference",
  "automation_validate",
  "automation_list",
  "automation_read",
  "automation_run_read",
] as const;
