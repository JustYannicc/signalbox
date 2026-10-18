/** Cloudflare facet entry source. The WASM import is resolved as a static module. */
export const RIPGREP_PROBE_SOURCE = String.raw`import { DurableObject } from "cloudflare:workers";
import rg from "./bin/rg.wasm";
import { ABI_VERSION, KernelProgramRegistry, callKernel } from "../../../src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../src/kernel/KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";

const artifact = {
  name: "ripgrep",
  version: "15.1.0",
  bytes: 2208393,
  sha256: "b88624f67935ecd82f757e29862d01ea5b98935ede62b8f69ba3284b7937a5c5",
};
const sourceInventory = "__RIPGREP_FACET_SOURCE_INVENTORY__";
const expectedImports = [
  "wasi_snapshot_preview1.args_get",
  "wasi_snapshot_preview1.args_sizes_get",
  "wasi_snapshot_preview1.clock_time_get",
  "wasi_snapshot_preview1.environ_get",
  "wasi_snapshot_preview1.environ_sizes_get",
  "wasi_snapshot_preview1.fd_close",
  "wasi_snapshot_preview1.fd_fdstat_get",
  "wasi_snapshot_preview1.fd_fdstat_set_flags",
  "wasi_snapshot_preview1.fd_filestat_get",
  "wasi_snapshot_preview1.fd_prestat_dir_name",
  "wasi_snapshot_preview1.fd_prestat_get",
  "wasi_snapshot_preview1.fd_readdir",
  "wasi_snapshot_preview1.fd_read",
  "wasi_snapshot_preview1.fd_seek",
  "wasi_snapshot_preview1.fd_write",
  "wasi_snapshot_preview1.path_filestat_get",
  "wasi_snapshot_preview1.path_open",
  "wasi_snapshot_preview1.path_readlink",
  "wasi_snapshot_preview1.poll_oneoff",
  "wasi_snapshot_preview1.proc_exit",
  "wasi_snapshot_preview1.random_get",
  "wasi_snapshot_preview1.sched_yield",
];
const manifest = Object.freeze({
  name: "ripgrep",
  version: "15.1.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: ["process.wait"],
  entrypoint: "ripgrep-wasi-v1",
});
const encoder = new TextEncoder();

export class ProbeFacet extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/proof" && path !== "/proof-again") {
      return new Response("Not found", { status: 404 });
    }
    const filesystem = new KernelFileSystem({
      mounts: [{
        path: "/",
        storage: createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n),
      }],
    });
    const wakes = new KernelWakeRegistry();
    try {
      ensureDirectory(filesystem, "/work");
      ensureDirectory(filesystem, "/outside");
      ensureFile(filesystem, "/search.txt", "root_needle_decoy\n");
      ensureFile(filesystem, "/work/search.txt", "needle\nother line\n");
      ensureFile(filesystem, "/outside/absolute.txt", "absolute_needle\n");
      const registry = new KernelProgramRegistry();
      const registered = registry.register(manifest);
      if (registered.status !== "ok") throw new Error("ripgrep registry failed: " + JSON.stringify(registered));
      const host = new KernelProgramHost({
        registry,
        wakes,
        programs: new Map([["/bin/rg", { manifest, implementation: { kind: "wasm", module: rg } }]]),
      });
      const resolved = host.resolve("/bin/rg");
      if (resolved.status !== "ok") throw new Error("ripgrep resolution failed: " + JSON.stringify(resolved));
      const before = snapshot(filesystem);
      const inline = await runCases(host, filesystem, resolved.value, false);
      const asynchronous = await runCases(host, filesystem, resolved.value, true);
      const after = snapshot(filesystem);
      assert(JSON.stringify(after) === JSON.stringify(before), "ripgrep changed the SQLite fixture files");
      return Response.json({
        ok: true,
        path,
        artifact,
        sourceInventory,
        imports: expectedImports,
        cwd: "/work",
        paths: { relative: "search.txt", absolute: "/outside/absolute.txt" },
        filesBefore: before,
        filesAfter: after,
        inline,
        asynchronous,
      });
    } catch (error) {
      return Response.json({ ok: false, path, error: String(error) }, { status: 500 });
    } finally {
      filesystem.dispose();
      wakes.dispose();
    }
  }
}

async function runCases(host, filesystem, program, asynchronous) {
  const cases = [
    { name: "relative", args: ["rg", "-n", "needle", "search.txt"], expected: "1:needle\n" },
    {
      name: "absolute",
      args: ["rg", "-n", "--with-filename", "--no-heading", "absolute_needle", "/outside/absolute.txt"],
      expected: "/outside/absolute.txt:1:absolute_needle\n",
    },
    { name: "version", args: ["rg", "--version"], expected: "ripgrep 15.1.0" },
  ];
  const results = [];
  for (const item of cases) {
    const piped = host.preparePiped({ filesystem }, { cwd: "/work" });
    const stdoutPromise = readStream(piped.stdout);
    const stderrPromise = readStream(piped.stderr);
    const writer = piped.stdin.getWriter();
    try { await writer.close(); } finally { writer.releaseLock(); }
    const cwd = piped.prepared.filesystem.cwd;
    if (cwd !== "/work") throw new Error("prepared cwd changed: " + cwd);
    let exit;
    try {
      if (asynchronous) {
        const spawned = callKernel(host.backend(piped.prepared), "process.spawn", {
          program,
          args: item.args,
          env: { PWD: cwd },
        });
        if (spawned.status !== "ok") throw new Error("ripgrep spawn failed: " + JSON.stringify(spawned));
        const status = await host.exitStatus(spawned.value);
        if (status.status !== "ok") throw new Error("ripgrep wait failed: " + JSON.stringify(status));
        exit = status.value.exitCode;
        if (status.value.signal !== 0) throw new Error("ripgrep was signalled: " + JSON.stringify(status.value));
        const reaped = host.reap(spawned.value);
        if (reaped.status !== "ok") throw new Error("ripgrep reap failed: " + JSON.stringify(reaped));
      } else {
        exit = host.runInline(piped.prepared, program, item.args, { PWD: cwd });
      }
    } finally {
      await piped.prepared.release();
    }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exit !== 0 || stderr !== "") throw new Error(item.name + " failed: " + JSON.stringify({ exit, stderr }));
    if (item.name === "version" ? !stdout.includes(item.expected) : stdout !== item.expected) {
      throw new Error(item.name + " output changed: " + JSON.stringify(stdout));
    }
    if (item.name === "relative" && stdout.includes("root_needle_decoy")) {
      throw new Error("relative path searched the root decoy");
    }
    results.push({ name: item.name, args: item.args, cwd, env: { PWD: cwd }, exit, stdout, stderr });
  }
  return results;
}

function ensureDirectory(filesystem, path) {
  try { filesystem.mkdir(path); }
  catch (error) {
    if (error?.code !== "EEXIST" || filesystem.stat(path).type !== "directory") throw error;
  }
}

function ensureFile(filesystem, path, expected) {
  try {
    const actual = readFile(filesystem, path);
    if (actual !== expected) throw new Error("fixture file changed: " + path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
    try { filesystem.write(fd, encoder.encode(expected), null); }
    finally { filesystem.close(fd); }
  }
}

function readFile(filesystem, path) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const chunks = [];
    for (;;) {
      const target = new Uint8Array(1024);
      const count = filesystem.read(fd, target, null);
      if (count === 0) break;
      chunks.push(new TextDecoder().decode(target.subarray(0, count)));
    }
    return chunks.join("");
  } finally { filesystem.close(fd); }
}

function snapshot(filesystem) {
  return {
    root: readFile(filesystem, "/search.txt"),
    work: readFile(filesystem, "/work/search.txt"),
    outside: readFile(filesystem, "/outside/absolute.txt"),
  };
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      output += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

function assert(condition, message) { if (!condition) throw new Error(message); }
`;
