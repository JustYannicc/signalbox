import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "./codex/types.ts";
import { runCodexProcess } from "./codex/process.ts";

export type { CodexHarnessProcess, CodexHarnessProcessOptions } from "./codex/types.ts";

/** The official module borrows the session facet's exact filesystem and descriptors. */
export async function startCodexHarnessProcess(
  options: CodexHarnessProcessOptions,
): Promise<CodexHarnessProcess> {
  options.stdio.assertBound(options.computer.files);
  if (options.stdio.filesystem !== options.computer.files)
    throw new TypeError("Codex stdio must belong to the Computer filesystem");
  if (options.bootstrap.cwd !== options.computer.files.cwd)
    throw new TypeError("Codex bootstrap must use the Computer working directory");
  if (!options.environment.CODEX_EXEC_SERVER_URL)
    throw new TypeError("Codex requires its session exec-server URL");
  return runCodexProcess(options);
}
