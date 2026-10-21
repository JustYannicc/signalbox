import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Artifact copying is cloud-owned; the source scanner is a scripts-workspace CLI. */
export async function verifyArtifactNodeBuiltins(directory: string) {
  const entry = NodeURL.fileURLToPath(
    new URL("../../../../scripts/harness-releases/nodeBuiltinGate/cli.ts", import.meta.url),
  );
  await execFile(process.execPath, [entry, directory], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}
