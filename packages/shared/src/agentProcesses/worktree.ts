// @effect-diagnostics nodeBuiltinImport:off - cleanup also runs before dependency installation.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";

export async function resolveProcessWorktree(cwd: string) {
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    { timeout: 10_000, encoding: "utf8" },
  );
  return NodeFSP.realpath(stdout.trim());
}
