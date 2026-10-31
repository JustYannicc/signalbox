// @effect-diagnostics nodeBuiltinImport:off - The official profiler command and its immutable attempt paths are shared by execution and evidence verification.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const startupProfileLimits = {
  deadlineMs: 90_000,
  sampleMs: 500,
  terminateMs: 10_000,
  killWaitMs: 10_000,
  rssBytes: 6 * 1_024 ** 3,
  heapMiB: 1_536,
  profileBytes: 32 * 1_024 ** 2,
  logBytes: 8 * 1_024 ** 2,
  outputBytes: 128 * 1_024 ** 2,
  diskFloorBytes: 10 * 1_024 ** 3,
  headroomBytes: 1_024 ** 3,
};

export function startupProfilePaths(main: string) {
  const output = `${main}.startup-profile`;
  return {
    output,
    workerFile: NodePath.join(output, "worker.bundle"),
    profileFile: NodePath.join(output, "startup.cpuprofile"),
    ledgerFile: NodePath.join(output, "native-children.jsonl"),
    configFile: NodePath.join(output, "wrangler.json"),
  };
}

export function startupProfilerCommand(
  runtime: { nodeExecutable: string; wranglerCli: string },
  main: string,
) {
  const paths = startupProfilePaths(main);
  return [
    runtime.nodeExecutable,
    `--max-old-space-size=${startupProfileLimits.heapMiB}`,
    "--no-warnings",
    "--import",
    NodeURL.fileURLToPath(new URL("./profileHook.ts", import.meta.url)),
    runtime.wranglerCli,
    "check",
    "startup",
    "--worker",
    paths.workerFile,
    "--outfile",
    paths.profileFile,
    "--config",
    paths.configFile,
  ];
}
