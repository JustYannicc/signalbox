/** Static Durable Object proof entry for the isomorphic-git HTTP adapter. */
export const KERNEL_GIT_HTTP_FACET_SOURCE = String.raw`import { DurableObject } from "cloudflare:workers";
import gitWasm from "./git.wasm";
import { createNodeGitProgram } from "../../../src/isolate/NodeGit.ts";
import { createNodeFs } from "../../../src/isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import { ABI_VERSION, KernelProgramRegistry, callKernel } from "../../../src/kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../src/kernel/KernelWakeRegistry.ts";
import {
  KERNEL_GIT_ARTIFACT,
  KERNEL_GIT_PROGRAM_MANIFEST,
  createKernelGitProgram,
} from "../../../src/kernel/KernelGitProgram.ts";

const SOURCE_INVENTORY = "__KERNEL_GIT_HTTP_SOURCE_INVENTORY__";
const COMMIT = "218b1da7cb6be4a4873f6bca0681b387b4cecab4";
const PACK_BASE64 = "UEFDSwAAAAIAAAAEkAx4nKWMQQrDIBAA775i74WyIRtRKKV/yAt2dW0FjSWY4vPbQ37QOc1hmL6rQkjRJrvIPJFGr5gss5BjkYUCTsG7OaA4Mnz0V9thzc+Ni7QBKY9+7Aq3Ux46uL6LXvP24ZLjHTxZ68ghwgV/mNBqzb3rfxdzluYL4vc+zKcEeJwBRwC4/zEwMDY0NCBSRUFETUUubWQAQDkuIZZePq3edELd+Vxtlu+2Nn4xMDA3NTUgcnVuLnNoAES5ayTuDdz1GjrY5rg8TZg9pkRcbMwbPD54nCtKzc0vSVUIcnV08XXlAgAmDQRltwF4nFNW1E/KzNMvzuBKTc7IV0jLrCgpLUrlAgBU4weRjLaGqDQo5R4Is8CADpPQToesV28=";
const CREDENTIALS = Object.freeze({ uid: 1001, gid: 1002, euid: 1001, egid: 1002 });
const ROOT_METADATA = Object.freeze({ mode: 0o755, uid: 1001, gid: 1002 });
const BASE_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_SYSTEM: "/etc/gitconfig",
  GIT_AUTHOR_NAME: "Kernel Git HTTP Proof",
  GIT_AUTHOR_EMAIL: "kernel-git-http@example.invalid",
  GIT_COMMITTER_NAME: "Kernel Git HTTP Proof",
  GIT_COMMITTER_EMAIL: "kernel-git-http@example.invalid",
});
const PACK = decodeBase64(PACK_BASE64);
const encoder = new TextEncoder();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export class KernelGitHttpFacet extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/proof" && path !== "/proof-again") {
      return new Response("Not found", { status: 404 });
    }

    const wakes = new KernelWakeRegistry();
    const storage = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1_000_000n);
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
      const fs = createNodeFs(filesystem).fs;
      for (const directory of ["/etc", "/home", "/home/test", "/work", "/work/repo"]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      if (!fs.existsSync("/README.md")) fs.writeFileSync("/README.md", "Root-relative decoy\n");
      if (!fs.existsSync("/work/README.md")) fs.writeFileSync("/work/README.md", "Cwd-relative decoy\n");
      fs.writeFileSync("/etc/gitconfig", [
        "[core]",
        "\tfilemode = true",
        "\tpager = cat",
        "[commit]",
        "\tgpgsign = false",
        "",
      ].join("\n"));

      const local = createKernelGitProgram({ module: gitWasm, credentials: CREDENTIALS });
      const implementation = createNodeGitProgram({ local, fetch: smartHttpFetch });
      const registry = new KernelProgramRegistry();
      const registered = registry.register(KERNEL_GIT_PROGRAM_MANIFEST);
      assert(registered.status === "ok", "Git registration failed: " + JSON.stringify(registered));
      host = new KernelProgramHost({
        registry,
        wakes,
        programs: new Map([[
          "/usr/bin/git",
          { manifest: KERNEL_GIT_PROGRAM_MANIFEST, implementation: { kind: "async", run: implementation.run } },
        ]]),
      });

      const alreadyCloned = fs.existsSync("/work/repo/.git/HEAD");
      const transfer = alreadyCloned
        ? await runGit(host, filesystem, "/work/repo", ["fetch", "origin"], {})
        : await runGit(host, filesystem, "/work", ["clone", "https://git.fixture/remote.git", "repo"], {});
      assertResult(transfer, 0);
      const content = await runGit(host, filesystem, "/work/repo", ["show", "HEAD:README.md"], BASE_ENVIRONMENT);
      assertResult(content, 0);
      assert(content.stdout === "remote README\n", "Cgit could not read the JS-created commit");
      const oid = await runGit(host, filesystem, "/work/repo", ["rev-parse", "--verify", "HEAD"], BASE_ENVIRONMENT);
      assertResult(oid, 0);
      assert(oid.stdout.trim() === COMMIT, "The fetched commit changed");
      const status = await runGit(host, filesystem, "/work/repo", ["status", "--porcelain"], BASE_ENVIRONMENT);
      assertResult(status, 0);
      assert(status.stdout === "", "The cloned repository is not clean");
      assert(filesystem.getPosixMetadata("/work/repo/run.sh").mode === 0o755, "Executable mode was not preserved");
      assert(filesystem.getPosixMetadata("/work/repo/README.md").mode === 0o644, "Regular mode was not preserved");
      assert(fs.readFileSync("/README.md", "utf8") === "Root-relative decoy\n", "Root decoy changed");
      assert(fs.readFileSync("/work/README.md", "utf8") === "Cwd-relative decoy\n", "Cwd decoy changed");
      assert(!fs.existsSync("/.git"), "Clone escaped its supplied cwd");
      assert(host.processes.size === 0, "Git process records remain after reaping");
      assert(wakes.size === 0, "Git left wake registrations behind");

      return Response.json({
        ok: true,
        path,
        coldClone: !alreadyCloned,
        sourceInventory: SOURCE_INVENTORY,
        gitArtifact: KERNEL_GIT_ARTIFACT,
        filesystem: "KernelFileSystem over Durable Object SQLite storage",
        cwd: "/work/repo",
        checks: ["real JS smart-HTTP clone or fetch", "Cgit reads the JS-created commit", "relative cwd root decoys", "POSIX file modes", "clean cold repeat"],
        commit: oid.stdout.trim(),
        status: status.stdout,
        processesRemaining: host.processes.size,
        wakesRemaining: wakes.size,
      });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally {
      try {
        const disposed = await host?.processes.dispose();
        if (disposed && disposed.status !== "ok") {
          throw new Error("Git process cleanup failed: " + JSON.stringify(disposed));
        }
      } finally {
        filesystem?.dispose();
        wakes.dispose();
      }
    }
  }
}

async function runGit(host, filesystem, cwd, args, env) {
  const output = { stdout: [], stderr: [] };
  const prepared = host.prepare({ filesystem, home: "/home/test" }, {
    cwd,
    stdio: [
      { readInto: () => 0 },
      { write: (bytes) => (output.stdout.push(new TextDecoder().decode(bytes)), bytes.byteLength) },
      { write: (bytes) => (output.stderr.push(new TextDecoder().decode(bytes)), bytes.byteLength) },
    ],
  });
  const resolved = host.resolve("/usr/bin/git");
  assert(resolved.status === "ok", "Git did not resolve: " + JSON.stringify(resolved));
  const spawned = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args: ["/usr/bin/git", ...args],
    env,
  });
  assert(spawned.status === "ok", "Git failed to start: " + JSON.stringify(spawned));
  await prepared.release();
  const status = await host.exitStatus(spawned.value);
  assert(status.status === "ok", "Git process failed: " + JSON.stringify(status));
  const reaped = host.reap(spawned.value);
  assert(reaped.status === "ok", "Git process was not reaped: " + JSON.stringify(reaped));
  return { ...status.value, stdout: output.stdout.join(""), stderr: output.stderr.join("") };
}

function assertResult(result, code) {
  assert(result.exitCode === code, "git exited " + result.exitCode + ": " + result.stderr);
}

async function smartHttpFetch(input, init) {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (method === "GET" && url.pathname.endsWith("/info/refs")) {
    return new Response(advertisement(), {
      headers: { "content-type": "application/x-git-upload-pack-advertisement" },
    });
  }
  if (method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
    return new Response(joinBytes(packet("NAK\n"), packet(joinBytes(new Uint8Array([1]), PACK)), encoder.encode("0000")), {
      headers: { "content-type": "application/x-git-upload-pack-result" },
    });
  }
  return new Response("not found", { status: 404 });
}

function advertisement() {
  return joinBytes(
    packet("# service=git-upload-pack\n"),
    encoder.encode("0000"),
    packet(COMMIT + " HEAD\0multi_ack ofs-delta side-band-64k symref=HEAD:refs/heads/main\n"),
    packet(COMMIT + " refs/heads/main\n"),
    encoder.encode("0000"),
  );
}

function packet(value) {
  const body = typeof value === "string" ? encoder.encode(value) : value;
  const length = (body.byteLength + 4).toString(16).padStart(4, "0");
  return joinBytes(encoder.encode(length), body);
}

function joinBytes(...chunks) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
`;
