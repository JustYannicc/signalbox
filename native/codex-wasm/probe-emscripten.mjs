import { DurableObject } from "cloudflare:workers";
import module from "./engine.wasm";
import { loadCodex } from "./loader.mjs";
import { info } from "./engine-info.mjs";

export async function runVersionProof() {
  const stdout = [];
  const stderr = [];
  const calls = new Set();
  const imports = {};
  let memory;
  // The Emscripten factory supplies libc. Kernel operations stay unavailable in
  // this version-only proof, so it cannot silently become a fake session host.
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (descriptor.module !== "signalbox_emscripten" && !descriptor.module.startsWith("host_"))
      continue;
    const name = `${descriptor.module}.${descriptor.name}`;
    (imports[descriptor.module] ??= {})[descriptor.name] = () => {
      calls.add(name);
      throw new Error(`Version proof does not implement ${name}`);
    };
  }
  const started = performance.now();
  const engine = await loadCodex(module, {
    imports,
    attach(instance) {
      memory = instance.exports.memory;
    },
    arguments: ["--version"],
    print: (line) => stdout.push(line),
    printErr: (line) => stderr.push(line),
  });
  await engine.run();
  const output = stdout.join("\n");
  const version = JSON.parse(output.trim());
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
    stdout: output,
    stderr: stderr.join("\n"),
    importCalls: [...calls].sort(),
    linearMemoryBytes: memory.buffer.byteLength,
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
