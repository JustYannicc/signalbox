import { ClaudeCliProcess } from "./ClaudeCliProcess.ts";
import { launchNodeHarnessProcess, type NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";
import { createClaudeCliFiles } from "./claude/CliFiles.ts";

type Arguments = ConstructorParameters<typeof ClaudeCliProcess>;

/** Local harness callers keep the same kernel binding; the remote CLI entry never imports this. */
export function createLocalClaudeCliProcess(
  options: Omit<NodeHarnessProcessInput, "signal">,
  input: Arguments[1],
  reporter: Arguments[2],
  observation?: Arguments[3],
  continuation?: Arguments[4],
) {
  return new ClaudeCliProcess(
    {
      ...options,
      stdio: {
        ...options.stdio,
        assertBound(files) {
          if (files !== options.computer.files) throw new Error("Claude changed its filesystem");
          options.stdio.assertBound(options.computer.files);
        },
      },
      files: createClaudeCliFiles(options.computer.files),
      launch: (process) =>
        launchNodeHarnessProcess({
          ...options,
          ...process,
          computer: options.computer,
          stdio: options.stdio,
        }),
    },
    input,
    reporter,
    observation,
    continuation,
  );
}
