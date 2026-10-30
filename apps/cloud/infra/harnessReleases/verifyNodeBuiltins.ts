import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { decodeHarnessReleaseBuiltinFindings } from "../../src/harnessReleases/HarnessReleaseBuiltinFindings.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Artifact copying is cloud-owned; the source scanner is a scripts-workspace CLI. */
export async function verifyArtifactNodeBuiltins(
  directory: string,
  purpose: "qualification" | "release" = "release",
) {
  const entry = NodeURL.fileURLToPath(
    new URL("../../../../scripts/harness-releases/nodeBuiltinGate/cli.ts", import.meta.url),
  );
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "builtin-findings-"));
  const result = NodePath.join(temporary, "findings.json");
  try {
    await execFile(process.execPath, [entry, directory, "--purpose", purpose, "--result", result], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return decodeHarnessReleaseBuiltinFindings(JSON.parse(await NodeFSP.readFile(result, "utf8")));
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
