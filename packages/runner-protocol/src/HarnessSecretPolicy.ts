const ROUTING_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OTEL_", "T3CODE_", "LD_", "DYLD_"];

// An application's OPENAI_API_KEY remains usable; OPENAI_BASE_URL changes the harness route.
const ROUTING_NAMES: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "OPENAI_BASE_URL",
]);

/** Folder secrets cannot redirect model traffic, copy it through telemetry, or load startup code. */
export const routesHarness = (name: string) =>
  ROUTING_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  ROUTING_NAMES.has(name) ||
  name.toUpperCase().endsWith("_PROXY");
