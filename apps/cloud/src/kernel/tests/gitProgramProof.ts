// @effect-diagnostics nodeBuiltinImport:off - pinned binary and in-memory database only.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { callKernel, KernelProgramRegistry } from "../KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../KernelFileSystem.ts";
import { KernelProgramHost } from "../KernelProgramHost.ts";
import { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import {
  createKernelGitProgram,
  KERNEL_GIT_ARTIFACT,
  KERNEL_GIT_PROGRAM_MANIFEST,
} from "../KernelGitProgram.ts";
import { sqliteFixture } from "./sqliteFixture.ts";
const gitArtifactPath = NodeURL.fileURLToPath(
  new URL("../../../infra/kernelPrograms/git/git.wasm", import.meta.url),
);

const rootMetadata = { mode: 0o755, uid: 1001, gid: 1002 } as const;
const credentials = { uid: 1001, gid: 1002, euid: 1001, egid: 1002 } as const;
const umask = 0o022;
const baseEnvironment = {
  GIT_CONFIG_SYSTEM: "/etc/gitconfig",
  GIT_AUTHOR_NAME: "Kernel Git Proof",
  GIT_AUTHOR_EMAIL: "kernel-git@example.invalid",
  GIT_COMMITTER_NAME: "Kernel Git Proof",
  GIT_COMMITTER_EMAIL: "kernel-git@example.invalid",
};

export async function proveKernelGitProgram(
  artifactPath = gitArtifactPath,
  artifactIdentity?: {
    readonly sha256: string;
    readonly bytes: number;
    readonly gitVersion: string;
  },
) {
  const artifact = Object.freeze({ ...KERNEL_GIT_ARTIFACT, ...artifactIdentity });
  const bytes = await NodeFSP.readFile(artifactPath);
  NodeAssert.equal(NodeCrypto.createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  NodeAssert.equal(bytes.byteLength, artifact.bytes);
  const module = new WebAssembly.Module(bytes);
  const fixture = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const storage = createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n);
  storage.posix.initialize(storage.root, rootMetadata);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: {
      credentials: {
        uid: credentials.uid,
        gid: credentials.gid,
        euid: credentials.euid,
        egid: credentials.egid,
      },
      umask,
    },
  });
  const registry = new KernelProgramRegistry();
  const registration = registry.register(KERNEL_GIT_PROGRAM_MANIFEST);
  if (registration.status !== "ok") {
    const reason =
      registration.status === "error" ? registration.error.message : "unexpected suspension";
    throw new Error(`Git registration failed: ${reason}`);
  }
  const implementation = createKernelGitProgram({ module, credentials });
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      ["/usr/bin/git", { manifest: KERNEL_GIT_PROGRAM_MANIFEST, implementation }],
    ]),
  });

  try {
    filesystem.mkdir("/etc");
    filesystem.mkdir("/home");
    filesystem.mkdir("/home/test");
    filesystem.mkdir("/work");
    filesystem.mkdir("/work/repo");
    await writeFile(
      filesystem,
      "/etc/gitconfig",
      [
        "[init]",
        "\ttemplateDir =",
        "\tdefaultBranch = main",
        "[gc]",
        "\tauto = 0",
        "[maintenance]",
        "\tauto = false",
        "[core]",
        "\tpager = cat",
        "\tfilemode = true",
        "[commit]",
        "\tgpgsign = false",
        "",
      ].join("\n"),
    );

    const version = await runGit(host, filesystem, "/work", "--version");
    assertResult(version, 0);
    NodeAssert.equal(version.stdout.trim(), `git version ${artifact.gitVersion}`);

    const init = await runGit(host, filesystem, "/work/repo", "init", ".");
    assertResult(init, 0);
    NodeAssert.equal(filesystem.getPosixMetadata("/work/repo").mode, 0o755);
    NodeAssert.equal(filesystem.getPosixMetadata("/work/repo/.git").mode, 0o755);
    NodeAssert.throws(() => filesystem.stat("/.git"));
    const repoRoot = await runGit(host, filesystem, "/work/repo", "rev-parse", "--show-toplevel");
    assertResult(repoRoot, 0);
    NodeAssert.equal(repoRoot.stdout.trim(), "/work/repo");

    await writeFile(filesystem, "/sample.txt", "Root-relative decoy\n");
    await writeFile(filesystem, "/absolute.txt", "Root absolute-path decoy\n");
    await writeFile(filesystem, "/work/repo/sample.txt", "Relative worktree file\n");
    await writeFile(filesystem, "/work/repo/absolute.txt", "Absolute worktree file\n");
    NodeAssert.deepEqual(filesystem.getPosixMetadata("/work/repo/sample.txt"), {
      mode: 0o644,
      uid: credentials.euid,
      gid: credentials.egid,
    });
    const add = await runGit(
      host,
      filesystem,
      "/work/repo",
      "add",
      "sample.txt",
      "/work/repo/absolute.txt",
    );
    assertResult(add, 0);
    const relativeContent = await runGit(host, filesystem, "/work/repo", "show", ":sample.txt");
    assertResult(relativeContent, 0);
    NodeAssert.equal(relativeContent.stdout, "Relative worktree file\n");
    const absoluteContent = await runGit(host, filesystem, "/work/repo", "show", ":absolute.txt");
    assertResult(absoluteContent, 0);
    NodeAssert.equal(absoluteContent.stdout, "Absolute worktree file\n");
    const stagedDiff = await runGit(host, filesystem, "/work/repo", "diff", "--cached", "--stat");
    assertResult(stagedDiff, 0);
    NodeAssert.match(stagedDiff.stdout, /sample\.txt\s+\|\s+1 \+/);
    NodeAssert.match(stagedDiff.stdout, /absolute\.txt\s+\|\s+1 \+/);

    const commit = await runGit(host, filesystem, "/work/repo", "commit", "-m", "Add sample file");
    assertResult(commit, 0);
    const cleanStatus = await runGit(host, filesystem, "/work/repo", "status", "--porcelain=v1");
    assertResult(cleanStatus, 0);
    NodeAssert.equal(cleanStatus.stdout, "");
    const cleanDiff = await runGit(host, filesystem, "/work/repo", "diff", "--exit-code");
    assertResult(cleanDiff, 0);
    NodeAssert.equal(cleanDiff.stdout, "");

    return {
      ok: true,
      artifact,
      filesystem: "KernelFileSystem over in-memory SQLite storage",
      checks: [
        "git --version",
        "git init with the supplied cwd and persisted POSIX modes",
        "relative and absolute git add path resolution with decoy files",
        "git add and staged diff from atomically created worktree files",
        "git commit and clean status/diff on shared SQLite state",
      ],
    };
  } finally {
    await host.processes.dispose();
    filesystem.dispose();
    fixture.close();
    wakes.dispose();
  }
}

async function runGit(
  host: KernelProgramHost,
  filesystem: KernelFileSystem,
  cwd: string,
  ...args: string[]
) {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const prepared = host.prepare(
    { filesystem, home: "/home/test" },
    {
      cwd,
      stdio: [
        { readInto: () => 0 },
        { write: (chunk) => (stdout.push(chunk.slice()), chunk.byteLength) },
        { write: (chunk) => (stderr.push(chunk.slice()), chunk.byteLength) },
      ],
    },
  );
  const resolved = host.resolve("/usr/bin/git");
  if (resolved.status !== "ok") {
    await prepared.release();
    throw new Error(`Git executable resolution failed: ${JSON.stringify(resolved)}`);
  }
  const admitted = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args: ["/usr/bin/git", ...args],
    env: baseEnvironment,
  });
  if (admitted.status !== "ok") {
    await prepared.release();
    throw new Error(`Git process admission failed: ${JSON.stringify(admitted)}`);
  }
  const status = await host.exitStatus(admitted.value);
  const reaped = host.reap(admitted.value);
  if (status.status !== "ok") throw new Error(`Git process failed: ${JSON.stringify(status)}`);
  if (reaped.status !== "ok") throw new Error(`Git process reap failed: ${JSON.stringify(reaped)}`);
  const decoder = new TextDecoder();
  return {
    exitCode: status.value.exitCode,
    signal: status.value.signal,
    coreDumped: status.value.coreDumped,
    stdout: stdout.map((chunk) => decoder.decode(chunk)).join(""),
    stderr: stderr.map((chunk) => decoder.decode(chunk)).join(""),
  };
}

function assertResult(result: Awaited<ReturnType<typeof runGit>>, expectedExitCode: number): void {
  NodeAssert.deepEqual(
    { exitCode: result.exitCode, signal: result.signal, coreDumped: result.coreDumped },
    { exitCode: expectedExitCode, signal: 0, coreDumped: false },
    JSON.stringify(result),
  );
  NodeAssert.equal(result.stderr, "");
}

async function writeFile(
  filesystem: KernelFileSystem,
  path: string,
  contents: string,
  mode = 0o666,
): Promise<void> {
  const lastSlash = path.lastIndexOf("/");
  const parentPath = lastSlash === 0 ? "/" : path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  const parent = filesystem.resolve(parentPath);
  const inode = filesystem.createInode(
    parent.mount,
    parent.inode,
    name,
    { type: "file", exclusive: true },
    mode,
  );
  let fd: number | undefined;
  try {
    fd = filesystem.open(path, KernelOpenFlags.O_WRONLY);
    filesystem.write(fd, new TextEncoder().encode(contents), 0n);
  } finally {
    if (fd !== undefined) filesystem.close(fd);
    await Promise.resolve(parent.mount.storage.release(inode));
  }
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await proveKernelGitProgram(), null, 2)}\n`);
}
