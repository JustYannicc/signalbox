/** Durable Object proof entry; Git is loaded as a static WASM module. */
export const KERNEL_GIT_FACET_SOURCE = String.raw`import { DurableObject } from "cloudflare:workers";
import git from "./git.wasm";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import { ABI_VERSION, KernelProgramRegistry, callKernel } from "../../../src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../src/kernel/KernelWakeRegistry.ts";
import {
  KERNEL_GIT_ARTIFACT,
  KERNEL_GIT_PROGRAM_MANIFEST,
  createKernelGitProgram,
} from "../../../src/kernel/KernelGitProgram.ts";

const SOURCE_INVENTORY = "__KERNEL_GIT_FACET_SOURCE_INVENTORY__";
const ROOT_METADATA = Object.freeze({ mode: 0o755, uid: 1001, gid: 1002 });
const CREDENTIALS = Object.freeze({ uid: 1001, gid: 1002, euid: 1001, egid: 1002 });
const BASE_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_SYSTEM: "/etc/gitconfig",
  GIT_AUTHOR_NAME: "Kernel Git Proof",
  GIT_AUTHOR_EMAIL: "kernel-git@example.invalid",
  GIT_COMMITTER_NAME: "Kernel Git Proof",
  GIT_COMMITTER_EMAIL: "kernel-git@example.invalid",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export class KernelGitFacet extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/proof" && path !== "/proof-again") {
      return new Response("Not found", { status: 404 });
    }

    const wakes = new KernelWakeRegistry();
    const storage = createFacetSqliteStorage(
      this.ctx.storage,
      () => BigInt(Date.now()) * 1_000_000n,
    );
    let filesystem;
    let host;
    try {
      try {
        storage.posix.initialize(storage.root, ROOT_METADATA);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      filesystem = new KernelFileSystem({
        mounts: [{ path: "/", storage }],
        posix: { credentials: CREDENTIALS, umask: 0o022 },
      });
      for (const directory of ["/etc", "/home", "/home/test", "/work", "/work/repo"]) {
        ensureDirectory(filesystem, directory);
      }
      writeFile(filesystem, "/etc/gitconfig", [
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
      ].join("\n"));

      const registry = new KernelProgramRegistry();
      const registered = registry.register(KERNEL_GIT_PROGRAM_MANIFEST);
      assert(registered.status === "ok", "Git registration failed: " + JSON.stringify(registered));
      const implementation = createKernelGitProgram({ module: git, credentials: CREDENTIALS });
      host = new KernelProgramHost({
        registry,
        wakes,
        programs: new Map([["/usr/bin/git", { manifest: KERNEL_GIT_PROGRAM_MANIFEST, implementation }]]),
      });

      const version = await runGit(host, filesystem, "/work", "--version");
      assertResult(version, 0);
      assert(version.stdout.trim() === "git version " + KERNEL_GIT_ARTIFACT.gitVersion, "Git version changed");
      const init = await runGit(host, filesystem, "/work/repo", "init", ".");
      assertResult(init, 0);
      assert(filesystem.getPosixMetadata("/work/repo").mode === 0o755, "Repository mode was not persisted");
      assert(filesystem.getPosixMetadata("/work/repo/.git").mode === 0o755, ".git mode was not persisted");
      assert(!exists(filesystem, "/.git"), "Git init escaped its supplied cwd");

      const hasCommit = (await runGit(host, filesystem, "/work/repo", "rev-parse", "--verify", "HEAD")).exitCode === 0;
      if (!hasCommit) {
        writeFile(filesystem, "/sample.txt", "Root-relative decoy\n");
        writeFile(filesystem, "/absolute.txt", "Root absolute-path decoy\n");
        writeFile(filesystem, "/work/repo/sample.txt", "Relative worktree file\n");
        writeFile(filesystem, "/work/repo/absolute.txt", "Absolute worktree file\n");
        assert(JSON.stringify(filesystem.getPosixMetadata("/work/repo/sample.txt")) === JSON.stringify({ mode: 0o644, uid: 1001, gid: 1002 }), "Seed file metadata changed");
        const add = await runGit(host, filesystem, "/work/repo", "add", "sample.txt", "/work/repo/absolute.txt");
        assertResult(add, 0);
        const relativeContent = await runGit(host, filesystem, "/work/repo", "show", ":sample.txt");
        assertResult(relativeContent, 0);
        assert(relativeContent.stdout === "Relative worktree file\n", "Relative add selected the root decoy");
        const absoluteContent = await runGit(host, filesystem, "/work/repo", "show", ":absolute.txt");
        assertResult(absoluteContent, 0);
        assert(absoluteContent.stdout === "Absolute worktree file\n", "Absolute add selected the wrong file");
        const stagedDiff = await runGit(host, filesystem, "/work/repo", "diff", "--cached", "--stat");
        assertResult(stagedDiff, 0);
        assert(/sample\.txt\s+\|\s+1 \+/.test(stagedDiff.stdout), "Relative file missing from staged diff");
        assert(/absolute\.txt\s+\|\s+1 \+/.test(stagedDiff.stdout), "Absolute file missing from staged diff");
        const commit = await runGit(host, filesystem, "/work/repo", "commit", "-m", "Add sample file");
        assertResult(commit, 0);
      }

      const cleanStatus = await runGit(host, filesystem, "/work/repo", "status", "--porcelain=v1");
      assertResult(cleanStatus, 0);
      assert(cleanStatus.stdout === "", "Repository did not persist clean status");
      const cleanDiff = await runGit(host, filesystem, "/work/repo", "diff", "--exit-code");
      assertResult(cleanDiff, 0);
      assert(cleanDiff.stdout === "", "Repository did not persist a clean diff");
      const stagedRelative = await runGit(host, filesystem, "/work/repo", "show", "HEAD:sample.txt");
      assertResult(stagedRelative, 0);
      assert(stagedRelative.stdout === "Relative worktree file\n", "Committed Git content changed");
      assert(host.processes.size === 0, "Git process records remain after reaping");
      assert(wakes.size === 0, "Git left wake registrations behind");

      return Response.json({
        ok: true,
        path,
        artifact: KERNEL_GIT_ARTIFACT,
        sourceInventory: SOURCE_INVENTORY,
        filesystem: "KernelFileSystem over Durable Object SQLite storage",
        cwd: "/work/repo",
        initializedOnThisRequest: !hasCommit,
        checks: ["git --version", "git init in supplied cwd", "relative and absolute git add with root decoys", "git commit", "clean status/diff persisted across requests"],
        status: cleanStatus.stdout,
        diff: cleanDiff.stdout,
        processesRemaining: host.processes.size,
        wakesRemaining: wakes.size,
      });
    } catch (error) {
      return Response.json({ ok: false, path, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally {
      await host?.processes.dispose();
      filesystem?.dispose();
      wakes.dispose();
    }
  }
}

async function runGit(host, filesystem, cwd, ...args) {
  const stdout = [];
  const stderr = [];
  const prepared = host.prepare({ filesystem, home: "/home/test" }, {
    cwd,
    stdio: [
      { readInto: () => 0 },
      { write: (chunk) => (stdout.push(chunk.slice()), chunk.byteLength) },
      { write: (chunk) => (stderr.push(chunk.slice()), chunk.byteLength) },
    ],
  });
  try {
    const resolved = host.resolve("/usr/bin/git");
    assert(resolved.status === "ok", "Git executable resolution failed: " + JSON.stringify(resolved));
    const admitted = callKernel(host.backend(prepared), "process.spawn", {
      program: resolved.value,
      args: ["/usr/bin/git", ...args],
      env: BASE_ENVIRONMENT,
    });
    assert(admitted.status === "ok", "Git process admission failed: " + JSON.stringify(admitted));
    const status = await host.exitStatus(admitted.value);
    const reaped = host.reap(admitted.value);
    assert(status.status === "ok", "Git process failed: " + JSON.stringify(status));
    assert(reaped.status === "ok", "Git process reap failed: " + JSON.stringify(reaped));
    const decoder = new TextDecoder();
    return {
      exitCode: status.value.exitCode,
      signal: status.value.signal,
      coreDumped: status.value.coreDumped,
      stdout: stdout.map((chunk) => decoder.decode(chunk)).join(""),
      stderr: stderr.map((chunk) => decoder.decode(chunk)).join(""),
    };
  } finally {
    await prepared.release();
  }
}

function assertResult(result, expectedExitCode) {
  assert(result.exitCode === expectedExitCode && result.signal === 0 && !result.coreDumped, "Unexpected Git status: " + JSON.stringify(result));
  assert(result.stderr === "", "Unexpected Git stderr: " + JSON.stringify(result));
}

function ensureDirectory(filesystem, path) {
  try {
    filesystem.mkdir(path);
  } catch (error) {
    if (error?.code !== "EEXIST" || filesystem.stat(path).type !== "directory") throw error;
  }
}

function exists(filesystem, path) {
  try {
    filesystem.stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function writeFile(filesystem, path, contents) {
  const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC | KernelOpenFlags.O_WRONLY, 0o666);
  try {
    filesystem.write(fd, new TextEncoder().encode(contents), 0n);
  } finally {
    filesystem.close(fd);
  }
}
`;
