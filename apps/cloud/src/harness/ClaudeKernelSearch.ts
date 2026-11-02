import type { ClaudeAgentSdkQueryOptions } from "@signalbox/provider-claude/ClaudeQueryRunner";

/** Keep the preset's other tools and permission rules while explicitly offering core Grep. */
export function claudeKernelSearchTools(tools: ClaudeAgentSdkQueryOptions["tools"]) {
  return Array.isArray(tools) ? tools : ["preset:default", "Grep"];
}

/** The isolate supplies rg through its kernel catalog rather than the native CLI executable. */
export function configureClaudeKernelSearch(env: object) {
  const path: unknown = Reflect.get(env, "PATH");
  const directories = typeof path === "string" ? path.split(":") : [];
  Reflect.set(env, "PATH", ["/bin", ...directories.filter((entry) => entry !== "/bin")].join(":"));
  Reflect.set(env, "USE_BUILTIN_RIPGREP", "0");
}
