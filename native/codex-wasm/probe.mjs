import { DurableObject } from "cloudflare:workers";
import module from "./engine.wasm";
import { loadCodex } from "./loader.mjs";
import { info } from "./engine-info.mjs";

class WasiExit extends Error {
  constructor(code) {
    super(`WASI exited ${code}`);
    this.code = code;
  }
}

// This host proves only artifact loading and --version. Full execution uses the
// session kernel; every other syscall fails so it cannot masquerade as turn proof.
function versionHost() {
  let memory;
  const stdout = [];
  const stderr = [];
  const calls = new Set();
  const encoder = new TextEncoder();
  const args = ["signalbox-codex-engine", "--version"].map((arg) => encoder.encode(arg + "\0"));
  const view = () => new DataView(memory.buffer);
  const imports = {};
  const implementations = {
    args_sizes_get(argc, size) {
      view().setUint32(argc, args.length, true);
      view().setUint32(
        size,
        args.reduce((total, arg) => total + arg.length, 0),
        true,
      );
      return 0;
    },
    args_get(argv, buffer) {
      for (let i = 0; i < args.length; i++) {
        view().setUint32(argv + i * 4, buffer, true);
        new Uint8Array(memory.buffer, buffer, args[i].length).set(args[i]);
        buffer += args[i].length;
      }
      return 0;
    },
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get() {
      return 0;
    },
    fd_write(fd, iovecs, count, written) {
      if (fd !== 1 && fd !== 2) throw new Error(`Unexpected version write fd ${fd}`);
      let total = 0;
      for (let i = 0; i < count; i++) {
        const pointer = view().getUint32(iovecs + i * 8, true);
        const length = view().getUint32(iovecs + i * 8 + 4, true);
        (fd === 1 ? stdout : stderr).push(new Uint8Array(memory.buffer, pointer, length).slice());
        total += length;
      }
      view().setUint32(written, total, true);
      return 0;
    },
    fd_fdstat_get(fd, pointer) {
      if (fd > 2) return 8;
      new Uint8Array(memory.buffer, pointer, 24).fill(0);
      view().setUint8(pointer, 2);
      return 0;
    },
    fd_close(fd) {
      if (fd > 2) return 8;
      return 0;
    },
    clock_time_get(_clock, _precision, pointer) {
      view().setBigUint64(pointer, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
    random_get(pointer, length) {
      for (let offset = 0; offset < length; offset += 65536) {
        crypto.getRandomValues(
          new Uint8Array(memory.buffer, pointer + offset, Math.min(65536, length - offset)),
        );
      }
      return 0;
    },
    proc_exit(code) {
      throw new WasiExit(code);
    },
  };
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const name = `${descriptor.module}.${descriptor.name}`;
    if (descriptor.kind !== "function") throw new Error(`Unexpected engine import kind: ${name}`);
    const implementation =
      descriptor.module === "wasi_snapshot_preview1" ? implementations[descriptor.name] : undefined;
    (imports[descriptor.module] ??= {})[descriptor.name] = (...values) => {
      calls.add(name);
      if (!implementation) throw new Error(`Version proof does not implement ${name}`);
      return implementation(...values);
    };
  }
  return {
    imports,
    attach(instance) {
      memory = instance.exports.memory;
    },
    result() {
      const decode = (chunks) => {
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(bytes);
      };
      return {
        stdout: decode(stdout),
        stderr: decode(stderr),
        linearMemoryBytes: memory.buffer.byteLength,
        importCalls: [...calls].sort(),
      };
    },
  };
}

export async function runVersionProof() {
  const host = versionHost();
  const started = performance.now();
  const engine = loadCodex(module, host);
  try {
    await engine.run();
  } catch (error) {
    if (!(error instanceof WasiExit) || error.code !== 0) throw error;
  }
  const result = host.result();
  const version = JSON.parse(result.stdout.trim());
  if (
    version.version !== info.version ||
    version.abiVersion !== info.abiVersion ||
    version.transport !== "app-server-ndjson"
  )
    throw new Error("Engine version/ABI mismatch");
  return {
    ok: true,
    scope: "artifact-version",
    version,
    ...result,
    moduleBytes: info.moduleBytes,
    moduleSha256: info.moduleSha256,
    elapsedMs: performance.now() - started,
  };
}

export class ProbeFacet extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/status") return Response.json({ info, scope: "artifact-version" });
    if (path === "/version") return Response.json(await runVersionProof());
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/version") return Response.json(await runVersionProof());
    return Response.json({ info, scope: "artifact-version" });
  },
};
