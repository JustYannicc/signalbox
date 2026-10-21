import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** The cloud CLI constructs and disposes the actual runtime; only module names cross this boundary. */
export async function captureRuntimeBuiltinSpecifiers(): Promise<readonly string[]> {
  const entry = NodeURL.fileURLToPath(
    new URL("../../apps/cloud/infra/harnessReleases/runtimeBuiltinInventory.ts", import.meta.url),
  );
  const { stdout } = await execFile(process.execPath, [entry], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name))
    throw new Error("NODE_BUILTIN_RUNTIME_INVENTORY_INVALID");
  return value;
}
