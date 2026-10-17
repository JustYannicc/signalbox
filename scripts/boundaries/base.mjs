import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { scanGraph } from "./graph.mjs";
import { WORKSPACE_MANIFEST } from "./workspaces.mjs";

export async function scanBase(root, commit) {
  const git = (args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const files = git(["ls-tree", "-r", "--name-only", "-z", commit])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const directories = files
    .filter((file) => WORKSPACE_MANIFEST.test(file))
    .map((file) => NodePath.posix.dirname(file));
  const snapshot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-boundary-base-"));
  try {
    // Extract committed sources only. Never install or execute the base's code or configuration.
    const archive = NodePath.join(snapshot, "sources.tar");
    git(["archive", "--format=tar", "--output", archive, commit, "--", ...directories]);
    NodeChildProcess.execFileSync("tar", ["-xf", archive, "-C", snapshot]);
    NodeFS.unlinkSync(archive);
    return await scanGraph(
      snapshot,
      files.filter((file) => directories.some((directory) => file.startsWith(`${directory}/`))),
    );
  } finally {
    NodeFS.rmSync(snapshot, { recursive: true, force: true });
  }
}
