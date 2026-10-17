// @effect-diagnostics nodeBuiltinImport:off - this module is the Node-only process registry boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const canonicalDirectory = (directory: string): string =>
  NodeFS.realpathSync(NodePath.resolve(directory));

export const lexicalDirectory = (directory: string): string => NodePath.resolve(directory);

export const resolveGitCommonDir = (worktreePath: string): string => {
  const output = NodeChildProcess.execFileSync(
    "git",
    ["-C", worktreePath, "rev-parse", "--git-common-dir"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    },
  ).trim();
  if (output.length === 0)
    throw new Error(`Git returned an empty common directory for ${worktreePath}`);
  return canonicalDirectory(NodePath.resolve(worktreePath, output));
};

const isPathWithin = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};

export const isPathWithinWorktree = (root: string, candidate: string): boolean => {
  if (!isPathWithin(root, candidate)) return false;
  let directory = candidate;
  while (directory !== root) {
    if (NodeFS.existsSync(NodePath.join(directory, ".git"))) return false;
    const parent = NodePath.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return true;
};

export const commonIndexDirectory = (commonDir: string): string =>
  NodePath.join(commonDir, "signalbox-agent-processes", "index");

export const worktreeRegistryDirectory = (worktreePath: string): string =>
  NodePath.join(worktreePath, ".t3", "agent-processes");
