// @effect-diagnostics nodeBuiltinImport:off - The fixture checks the pinned Git artifact and index.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { KERNEL_GIT_ARTIFACT } from "../../../kernel/KernelGitProgram.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { ComputerExecPort } from "../../../computer/Computer.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";

export interface RepositoryFile {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly bytes?: Uint8Array;
  readonly target?: string;
}

export function gitArtifactPath() {
  return (
    NodeProcess.env.SIGNALBOX_GIT_ARTIFACT_PATH ??
    NodePath.resolve(import.meta.dirname, "../../../../../../.t3/issue-1263/programs/git.wasm")
  );
}

export function hasGitArtifact() {
  return NodeFS.existsSync(gitArtifactPath());
}

export function loadPinnedGitModule() {
  const path = gitArtifactPath();
  const bytes = NodeFS.readFileSync(path);
  NodeAssert.equal(bytes.byteLength, KERNEL_GIT_ARTIFACT.bytes, "Unexpected pinned Git size");
  NodeAssert.equal(
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    KERNEL_GIT_ARTIFACT.sha256,
    "Unexpected pinned Git hash",
  );
  return new WebAssembly.Module(bytes);
}

export function createRepositoryImage() {
  // Host Git only creates the index image; ProductHost executes the pinned WASM below.
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "signalbox-producthost-repository-"),
  );
  const repository = NodePath.join(directory, "repo");
  const env = {
    PATH: NodeProcess.env.PATH ?? "/usr/bin:/bin",
    HOME: directory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_INDEX_VERSION: "2",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  try {
    NodeFS.mkdirSync(repository);
    NodeFS.writeFileSync(NodePath.join(repository, "tracked.txt"), "tracked content\n");
    runHostGit(repository, ["init", "--initial-branch=main"], env);
    runHostGit(repository, ["add", "."], env);
    runHostGit(
      repository,
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Seed",
      ],
      env,
    );
    zeroIndexStats(NodePath.join(repository, ".git", "index"));
    return snapshotTree(repository);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

export function installRepositoryImage(files: KernelFileSystem, image: readonly RepositoryFile[]) {
  const fs = nodeFs(files);
  for (const entry of image) {
    if (entry.kind !== "directory") continue;
    fs.mkdirSync(entry.path, { recursive: true, mode: entry.mode });
  }
  for (const entry of image) {
    if (entry.kind === "file") {
      if (entry.bytes === undefined) throw new Error(`Missing bytes for ${entry.path}`);
      fs.writeFileSync(entry.path, entry.bytes, { mode: entry.mode });
      fs.chmodSync(entry.path, entry.mode);
    } else if (entry.kind === "symlink") {
      if (entry.target === undefined) throw new Error(`Missing target for ${entry.path}`);
      fs.symlinkSync(entry.target, entry.path);
    }
  }
}

export function trackReadsFor(files: KernelFileSystem, path: string) {
  const inode = files.resolve(path).inode;
  const storage = files.resolve("/workspace").mount.storage;
  const readInto = storage.readInto.bind(storage);
  const reads: number[] = [];
  const observeRead: typeof storage.readInto = (candidate, offset, target) => {
    const result = readInto(candidate, offset, target);
    if (candidate === inode) {
      if (typeof result !== "number")
        throw new Error("Repository fixture needs synchronous storage");
      reads.push(result);
    }
    return result;
  };
  Object.defineProperty(storage, "readInto", { configurable: true, value: observeRead });
  return {
    reads,
    clear() {
      reads.length = 0;
    },
  };
}

export async function runGit(
  computer: ComputerExecPort,
  args: readonly string[],
  cwd = "/workspace",
) {
  const child = await computer.exec(
    {
      executable: "/usr/bin/git",
      argv: ["/usr/bin/git", ...args],
      cwd,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/home/codex",
        LANG: "C",
        LC_ALL: "C",
      },
    },
    new AbortController().signal,
    undefined,
  );
  try {
    const input = child.stdin.getWriter();
    await input.close();
    input.releaseLock();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, ...exit };
  } finally {
    await child.dispose();
  }
}

function runHostGit(cwd: string, args: readonly string[], env: Readonly<Record<string, string>>) {
  NodeChildProcess.execFileSync("git", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

function nodeFs(files: KernelFileSystem) {
  return createNodeFs(files).fs;
}

function zeroIndexStats(path: string) {
  const original = NodeFS.readFileSync(path);
  if (!(original instanceof Uint8Array)) throw new Error("Index is not bytes");
  const bytes = new Uint8Array(original);
  const view = new DataView(bytes.buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "DIRC" || view.getUint32(4) !== 2)
    throw new Error("Fixture requires a Git v2 index");
  const count = view.getUint32(8);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if ((view.getUint16(offset + 60) & 0x4000) !== 0)
      throw new Error("Fixture does not rewrite extended index flags");
    const end = bytes.indexOf(0, offset + 62);
    if (end < 0) throw new Error("Index entry has no terminator");
    bytes.fill(0, offset, offset + 24);
    bytes.fill(0, offset + 28, offset + 40);
    offset += Math.ceil((end + 1 - offset) / 8) * 8;
  }
  bytes.set(
    NodeCrypto.createHash("sha1").update(bytes.subarray(0, -20)).digest(),
    bytes.length - 20,
  );
  NodeFS.writeFileSync(path, bytes);
}

function snapshotTree(root: string): RepositoryFile[] {
  const image: RepositoryFile[] = [];
  const visit = (path: string) => {
    const info = NodeFS.lstatSync(path);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      image.push({
        path: workspacePath(root, path),
        kind: "symlink",
        mode,
        target: NodeFS.readlinkSync(path),
      });
      return;
    }
    if (!info.isDirectory()) {
      const bytes = NodeFS.readFileSync(path);
      if (!(bytes instanceof Uint8Array)) throw new Error(`Unexpected file contents at ${path}`);
      image.push({
        path: workspacePath(root, path),
        kind: "file",
        mode,
        bytes: new Uint8Array(bytes),
      });
      return;
    }
    image.push({ path: workspacePath(root, path), kind: "directory", mode });
    for (const entry of NodeFS.readdirSync(path, { withFileTypes: true }))
      visit(`${path}/${entry.name}`);
  };
  visit(root);
  return image;
}

function workspacePath(root: string, path: string) {
  const relative = NodePath.relative(root, path);
  return relative.length === 0
    ? "/workspace"
    : `/workspace/${relative.split(NodePath.sep).join("/")}`;
}
