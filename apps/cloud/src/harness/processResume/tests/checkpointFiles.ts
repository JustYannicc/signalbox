// @effect-diagnostics nodeBuiltinImport:off - the fixture persists checkpoint bytes in isolated temp files.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface PlainNativeState {
  readonly nativeSessionId: string;
  readonly turn: number;
  readonly transcript: readonly string[];
}

export interface PlainWorkspaceState {
  readonly files: Readonly<Record<string, string>>;
}

export interface PlainCheckpointFiles {
  readonly nativePath: string;
  readonly workspacePath: string;
  readonly write: (native: PlainNativeState, workspace: PlainWorkspaceState) => void;
  readonly read: () => {
    readonly nativeBytes: Buffer;
    readonly workspaceBytes: Buffer;
  };
}

export function createPlainCheckpointFiles(
  directory: string,
  native: PlainNativeState,
  workspace: PlainWorkspaceState,
): PlainCheckpointFiles {
  NodeFS.mkdirSync(directory, { recursive: true });
  const nativePath = NodePath.join(directory, "native.json");
  const workspacePath = NodePath.join(directory, "workspace.json");
  const write = (nextNative: PlainNativeState, nextWorkspace: PlainWorkspaceState) => {
    const nativeTemp = `${nativePath}.pending`;
    const workspaceTemp = `${workspacePath}.pending`;
    NodeFS.writeFileSync(nativeTemp, JSON.stringify(nextNative));
    NodeFS.writeFileSync(workspaceTemp, JSON.stringify(nextWorkspace));
    NodeFS.renameSync(nativeTemp, nativePath);
    NodeFS.renameSync(workspaceTemp, workspacePath);
  };
  write(native, workspace);
  return {
    nativePath,
    workspacePath,
    write,
    read: () => ({
      nativeBytes: NodeFS.readFileSync(nativePath),
      workspaceBytes: NodeFS.readFileSync(workspacePath),
    }),
  };
}

export const plainCheckpointDigest = (nativeBytes: Uint8Array, workspaceBytes: Uint8Array) =>
  NodeCrypto.createHash("sha256")
    .update(nativeBytes)
    .update("\0")
    .update(workspaceBytes)
    .digest("hex");

export interface PlainGitWorkspaceSnapshot {
  readonly indexSha256: string;
  readonly files: Readonly<Record<string, { readonly mode: number; readonly sha256: string }>>;
  readonly status: string;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly indexEntries: string;
  readonly tree: string;
}

export interface PlainGitWorkspace {
  readonly path: string;
  readonly indexPath: string;
  readonly snapshot: () => PlainGitWorkspaceSnapshot;
}

export function createPlainGitWorkspace(directory: string): PlainGitWorkspace {
  const path = NodePath.join(directory, "git-workspace");
  NodeFS.mkdirSync(path, { recursive: true });
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: path, encoding: "utf8" });

  git("init", "--quiet");
  git("config", "user.name", "Plain process proof");
  git("config", "user.email", "plain-process-proof@example.invalid");
  git("config", "core.filemode", "true");
  git("config", "core.autocrlf", "false");

  NodeFS.writeFileSync(NodePath.join(path, "tracked.txt"), "base\n");
  NodeFS.writeFileSync(NodePath.join(path, "script.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  git("add", "tracked.txt", "script.sh");
  git("commit", "--quiet", "-m", "base");

  NodeFS.writeFileSync(NodePath.join(path, "tracked.txt"), "staged content\n");
  NodeFS.writeFileSync(NodePath.join(path, "staged-only.txt"), "staged file\n");
  git("add", "tracked.txt", "staged-only.txt");
  NodeFS.writeFileSync(NodePath.join(path, "tracked.txt"), "unstaged content\n");

  NodeFS.chmodSync(NodePath.join(path, "script.sh"), 0o755);
  git("add", "script.sh");
  NodeFS.chmodSync(NodePath.join(path, "script.sh"), 0o644);
  NodeFS.writeFileSync(NodePath.join(path, "untracked.txt"), "untracked file\n");
  NodeFS.symlinkSync("tracked.txt", NodePath.join(path, "tracked-link"));

  const submodule = NodePath.join(directory, "gitlink-repository");
  NodeFS.mkdirSync(submodule, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: submodule });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Plain process proof"], {
    cwd: submodule,
  });
  NodeChildProcess.execFileSync(
    "git",
    ["config", "user.email", "plain-process-proof@example.invalid"],
    {
      cwd: submodule,
    },
  );
  NodeFS.writeFileSync(NodePath.join(submodule, "child.txt"), "gitlink target\n");
  NodeChildProcess.execFileSync("git", ["add", "child.txt"], { cwd: submodule });
  NodeChildProcess.execFileSync("git", ["commit", "--quiet", "-m", "child"], {
    cwd: submodule,
  });
  const gitlinkCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: submodule,
    encoding: "utf8",
  }).trim();
  git("update-index", "--add", "--cacheinfo", `160000,${gitlinkCommit},vendor`);

  const indexPath = NodePath.join(path, ".git", "index");
  const snapshot = () => readPlainGitWorkspaceSnapshot(path);

  return { path, indexPath, snapshot };
}

export function readPlainGitWorkspaceSnapshot(path: string): PlainGitWorkspaceSnapshot {
  const indexPath = NodePath.join(path, ".git", "index");
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: path, encoding: "utf8" });
  const status = git(
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  const stagedDiff = git("diff", "--cached", "--binary", "--no-ext-diff");
  const unstagedDiff = git("diff", "--binary", "--no-ext-diff");
  const indexEntries = git("ls-files", "--stage");
  const tree = git("write-tree").trim();
  const files: Record<string, { mode: number; sha256: string }> = {};
  for (const name of NodeFS.readdirSync(path).toSorted()) {
    if (name === ".git") continue;
    const filePath = NodePath.join(path, name);
    const stat = NodeFS.lstatSync(filePath);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(NodeFS.readlinkSync(filePath))
      : NodeFS.readFileSync(filePath);
    files[name] = {
      mode: stat.mode & 0o777,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return {
    indexSha256: NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(indexPath))
      .digest("hex"),
    files,
    status,
    stagedDiff,
    unstagedDiff,
    indexEntries,
    tree,
  };
}
