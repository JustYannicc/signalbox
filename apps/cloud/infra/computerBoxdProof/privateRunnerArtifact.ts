// @effect-diagnostics nodeBuiltinImport:off - validate trusted build output before proof deployment.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runProcess } from "../isolateProbe/process.ts";

const FAILURE_MESSAGE = "Runner artifact preflight failed";
const INVALID_OPTION = "--signalbox-proof-invalid-option";
const TIMEOUT_MS = 15_000;

function isInside(directory: string, candidate: string) {
  const relative = NodePath.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

// The isolated location avoids workspace dependencies. This checks loadability, not untrusted code.
export async function preflightTrustedRunnerArtifact(
  artifact: Uint8Array,
  workspaceRoot: string,
): Promise<void> {
  let tempDir: string | undefined;
  let failed = false;
  try {
    tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-proof-runner-"));
    const isolatedDir = await NodeFSP.realpath(tempDir);
    const isolatedWorkspaceRoot = await NodeFSP.realpath(workspaceRoot);
    if (isInside(isolatedWorkspaceRoot, isolatedDir)) {
      throw new Error(FAILURE_MESSAGE);
    }

    const artifactPath = NodePath.join(isolatedDir, "command-runner.mjs");
    await NodeFSP.writeFile(artifactPath, artifact, { flag: "wx", mode: 0o600 });
    const result = await runProcess({
      command: process.execPath,
      args: [artifactPath, INVALID_OPTION],
      cwd: isolatedDir,
      env: {},
      timeoutMs: TIMEOUT_MS,
    });
    if (
      result.code !== 1 ||
      !result.stderr.includes("ERR_PARSE_ARGS_UNKNOWN_OPTION") ||
      !result.stderr.includes(INVALID_OPTION)
    ) {
      throw new Error(FAILURE_MESSAGE);
    }
  } catch {
    failed = true;
  } finally {
    if (tempDir) {
      try {
        await NodeFSP.rm(tempDir, { recursive: true, force: true });
      } catch {
        failed = true;
      }
    }
  }

  if (failed) throw new Error(FAILURE_MESSAGE);
}
