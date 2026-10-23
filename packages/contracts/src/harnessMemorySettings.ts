/** Native package defaults. Release builds verify their reads and defaults before publishing. */
export const CLAUDE_MEMORY_ENV = {
  BASH_MAX_OUTPUT_LENGTH: "30000",
  CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "25000",
  CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "10",
} as const;

export const CODEX_MEMORY_CONFIG = {
  project_doc_max_bytes: 32768,
  "memories.max_rollouts_per_startup": 2,
  "memories.max_rollout_age_days": 10,
  "memories.max_raw_memories_for_consolidation": 256,
  "memories.max_unused_days": 30,
} as const;
