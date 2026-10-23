/** Retention pins require output-equivalence proof; the other pins match native defaults. */
export const CLAUDE_MEMORY_DEFAULT_ENV = {
  BASH_MAX_OUTPUT_LENGTH: "30000",
  CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "25000",
  CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "10",
} as const;

export const CLAUDE_MEMORY_RETENTION_ENV = {
  CLAUDE_CODE_TRANSCRIPT_LOCAL_GC: "1",
} as const;

export const CLAUDE_MEMORY_ENV = {
  ...CLAUDE_MEMORY_DEFAULT_ENV,
  ...CLAUDE_MEMORY_RETENTION_ENV,
} as const;

export const CODEX_MEMORY_CONFIG = {
  project_doc_max_bytes: 32768,
} as const;
