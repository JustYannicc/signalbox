// @effect-diagnostics nodeBuiltinImport:off - build-time static module preparation, never guest compilation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

const artifact = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "packages/worker/wasm/bash/bash.async.wasm",
  sha256: "ddc86c1422556654f02edf083f70017275bbc52f53781d1b74ac538bc7d0b102",
  bytes: 3_887_678,
});
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sourceMarker = "__KERNEL_BASH_PROOF_SOURCE_INVENTORY__";

/** Build once; the same static modules go to local and deployed probe sessions. */
export async function prepareKernelBashFacet(destination: string, bashPath: string) {
  const bytes = await NodeFSP.readFile(bashPath);
  if (bytes.byteLength !== artifact.bytes || digest(bytes) !== artifact.sha256) {
    throw new Error("GNU Bash artifact does not match its frozen source pin");
  }
  const cloudRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const build = await Esbuild.build({
    absWorkingDir: cloudRoot,
    stdin: {
      contents: facetSource(),
      resolveDir: cloudRoot,
      sourcefile: "bash-proof-facet.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: ["cloudflare:workers", "node:*", "./bash.wasm"],
  });
  const sources = await Promise.all(
    Object.keys(build.metafile.inputs)
      .filter((name) => name !== "bash-proof-facet.ts")
      .sort()
      .map(async (name) => {
        const input = await NodeFSP.readFile(NodePath.resolve(cloudRoot, name));
        return { path: name, bytes: input.byteLength, sha256: digest(input) };
      }),
  );
  const builderBytes = await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url));
  sources.push({
    path: "infra/kernelPrograms/bash/prepareFacet.ts",
    bytes: builderBytes.byteLength,
    sha256: digest(builderBytes),
  });
  const output = build.outputFiles[0]?.text;
  if (output === undefined || !output.includes(JSON.stringify(sourceMarker))) {
    throw new Error("Bash facet bundle lost its source inventory marker");
  }
  const main = output.replace(JSON.stringify(sourceMarker), JSON.stringify(sources));
  await NodeFSP.mkdir(destination, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(NodePath.join(destination, "bash.wasm"), bytes);
  const inventory = {
    artifact,
    sources,
    modules: [
      { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
      { name: "bash.wasm", type: "wasm", bytes: bytes.byteLength, sha256: digest(bytes) },
    ],
  };
  await NodeFSP.writeFile(
    NodePath.join(destination, "inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        id: "kernel-gnu-bash-v1",
        mainModule: "main.js",
        entrypoint: "ProbeFacet",
        mode: "facet",
        allowOutbound: false,
        modules: {
          "main.js": { path: "main.js", type: "js" },
          "bash.wasm": { path: "bash.wasm", type: "wasm" },
        },
        paths: ["/proof", "/proof-again"],
      },
      null,
      2,
    )}\n`,
  );
  return inventory;
}

function facetSource(): string {
  const codexCommand = "printf '%s\\n' codex-exec-ok";
  const pipeline = "printf '%s\\n' piped | { IFS= read -r value; printf '<%s>\\n' \"$value\"; }";
  return `import { DurableObject } from "cloudflare:workers";
import bash from "./bash.wasm";
import { ABI_VERSION, KernelProgramRegistry, callKernel } from "./src/kernel/KernelAbi.ts";
import { createKernelBashProgram } from "./src/kernel/KernelBashProgram.ts";
import { KernelProgramHost } from "./src/kernel/KernelProgramHost.ts";
import { KernelFileSystem, KernelOpenFlags } from "./src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "./src/kernel/KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "./src/kernel/FacetSqliteStorage.ts";

const artifact = ${JSON.stringify(artifact)};
const sources = ${JSON.stringify(sourceMarker)};
const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000, umask: 0o22, hostname: "bash-proof" };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return value + decoder.decode();
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

async function shell(host, filesystem, script) {
  const piped = host.preparePiped({ filesystem }, { cwd: "/workspace" });
  const stdout = text(piped.stdout);
  const stderr = text(piped.stderr);
  let handle;
  try {
    const writer = piped.stdin.getWriter();
    try { await writer.close(); } finally { writer.releaseLock(); }
    const resolved = host.resolve("/bin/bash");
    assert(resolved.status === "ok", "GNU Bash did not resolve");
    const spawned = callKernel(host.backend(piped.prepared), "process.spawn", {
      program: resolved.value, args: ["/bin/bash", "-c", script], env: {},
    });
    assert(spawned.status === "ok", "GNU Bash admission failed: " + JSON.stringify(spawned));
    handle = spawned.value;
    const result = await host.exitStatus(handle);
    const streams = await Promise.all([stdout, stderr]);
    assert(result.status === "ok", "GNU Bash execution failed: " + JSON.stringify(result));
    assert(result.value.exitCode === 0 && result.value.signal === 0, "GNU Bash exit status: " + JSON.stringify(result.value));
    const reaped = host.reap(handle);
    assert(reaped.status === "ok", "GNU Bash could not be reaped");
    handle = undefined;
    return { argv: ["/bin/bash", "-c", script], cwd: "/workspace", env: {}, exit: result.value, stdout: streams[0], stderr: streams[1], stdoutEof: true, stderrEof: true };
  } finally {
    await piped.prepared.release();
    if (handle !== undefined) host.reap(handle);
    await Promise.allSettled([stdout, stderr]);
  }
}

function readFile(filesystem, path) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = filesystem.read(fd, bytes.subarray(offset), null);
      if (count === 0) break;
      offset += count;
    }
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } finally { filesystem.close(fd); }
}

export class ProbeFacet extends DurableObject {
  async fetch(request) {
    if (!["/proof", "/proof-again"].includes(new URL(request.url).pathname)) {
      return new Response("Not found", { status: 404 });
    }
    const checks = [];
    const check = async (name, run) => {
      try { checks.push({ name, ok: true, details: await run() }); }
      catch (error) { checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    };
    const wakes = new KernelWakeRegistry();
    let filesystem;
    let host;
    try {
      const storage = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n);
      filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
      try { filesystem.mkdir("/workspace"); }
      catch (error) { if (!(error && error.code === "EEXIST")) throw error; }
      const registry = new KernelProgramRegistry();
      const manifest = { name: "gnu-bash", version: artifact.revision, abiVersion: ABI_VERSION, requiredCapabilities: ["process.wait"], entrypoint: "/bin/bash" };
      assert(registry.register(manifest).status === "ok", "GNU Bash registration failed");
      host = new KernelProgramHost({ registry, wakes, programs: new Map([["/bin/bash", { manifest, implementation: createKernelBashProgram({ module: bash, credentials }) }]]) });
      await check("exact non-login Codex exec_command", async () => {
        const result = await shell(host, filesystem, ${JSON.stringify(codexCommand)});
        assert(result.stdout === "codex-exec-ok\\n", "Unexpected stdout: " + JSON.stringify(result));
        assert(result.stderr === "", "Unexpected stderr: " + JSON.stringify(result));
        return result;
      });
      await check("Bash redirection persists in the same SQLite filesystem", async () => {
        const result = await shell(host, filesystem, "echo ok > /workspace/bash-proof-result");
        const contents = readFile(filesystem, "/workspace/bash-proof-result");
        assert(contents === "ok\\n", "Redirected bytes differ: " + JSON.stringify(contents));
        assert(result.stdout === "" && result.stderr === "", "Redirection leaked output: " + JSON.stringify(result));
        return { ...result, path: "/workspace/bash-proof-result", contents, sameFilesystem: true };
      });
      await check("Asyncify fork and wait use a shared kernel pipe", async () => {
        const result = await shell(host, filesystem, ${JSON.stringify(pipeline)});
        assert(result.stdout === "<piped>\\n" && result.stderr === "", "Pipeline output differs: " + JSON.stringify(result));
        return result;
      });
      await check("processes and wakeups are reaped after EOF", () => {
        assert(host.processes.size === 0, "Process table retained children");
        assert(wakes.size === 0, "Wake registry retained waits");
        return { processes: host.processes.size, wakes: wakes.size };
      });
    } catch (error) {
      checks.push({ name: "facet setup", ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        const disposed = await host?.processes.dispose();
        if (disposed && disposed.status !== "ok") throw new Error(JSON.stringify(disposed));
        filesystem?.dispose();
        wakes.dispose();
      } catch (error) { checks.push({ name: "facet cleanup", ok: false, error: String(error) }); }
    }
    return Response.json({ ok: checks.every((check) => check.ok), checks, inventory: { artifact, sources }, credentials: { kind: "synthetic proof identity", ...credentials }, staticModule: true, outbound: false });
  }
}
`;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  const bashPath = process.argv[3];
  if (!destination || !bashPath)
    throw new Error("Pass a fixture output directory and pinned GNU Bash wasm path");
  await prepareKernelBashFacet(NodePath.resolve(destination), NodePath.resolve(bashPath));
}
