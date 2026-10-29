import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { assertSourceFreeze, type TrustedComputerSourceFreeze } from "./identity.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Run the scripts-workspace source-freeze API out of process to respect workspace boundaries. */
export async function captureCurrentSourceFreeze(
  repository: string,
): Promise<TrustedComputerSourceFreeze> {
  const sourceFreezePath = NodePath.join(repository, "scripts/harness-releases/sourceFreeze.ts");
  const sourceFreezeUrl = NodeURL.pathToFileURL(sourceFreezePath).href;
  const script = [
    `const sourceFreeze = await import(${JSON.stringify(sourceFreezeUrl)});`,
    `const value = sourceFreeze.readSourceFreeze(await sourceFreeze.freezeSources(${JSON.stringify(repository)}));`,
    "process.stdout.write(JSON.stringify(value));",
  ].join("\n");
  const { stdout } = await execFile(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const source: unknown = JSON.parse(stdout);
  assertSourceFreeze(source as TrustedComputerSourceFreeze);
  return source as TrustedComputerSourceFreeze;
}
