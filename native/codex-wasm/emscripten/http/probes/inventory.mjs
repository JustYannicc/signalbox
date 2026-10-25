import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { loadCodex } from "./loader.mjs";
import { createEmscriptenHost } from "./host.mjs";

const kernelUrl = NodeURL.pathToFileURL(process.env.SIGNALBOX_KERNEL_ABI_MODULE);
const { KernelWakeRegistry, attemptKernelOperation } = await import(kernelUrl);
const module = new WebAssembly.Module(
  await NodeFSP.readFile(new URL("./engine.wasm", import.meta.url)),
);
const imports = WebAssembly.Module.imports(module);
const expected = [
  "net_close",
  "net_connect",
  "net_recv",
  "net_send",
  "net_setsockopt",
  "net_socket",
  "net_tls_connect",
];
const network = imports.filter((entry) => entry.module === "host_net");
NodeAssert.deepEqual(network.map((entry) => entry.name).sort(), expected);
NodeAssert.ok(network.every((entry) => entry.kind === "function"));
NodeAssert.equal(
  imports.some((entry) => /pthread|thread_spawn|futex/.test(entry.name)),
  false,
);
const wakes = new KernelWakeRegistry();
const host = createEmscriptenHost({ wakes, attemptKernelOperation });
try {
  await NodeAssert.rejects(loadCodex(module, host), /Missing Codex kernel import: host_net\.net_/);
  NodeAssert.equal(host.activeReactors, 0);
  NodeAssert.equal(wakes.size, 0);
} finally {
  host.dispose();
  wakes.dispose();
}
await NodeFSP.writeFile(
  new URL("./module-inventory.json", import.meta.url),
  JSON.stringify(
    {
      imports,
      exports: WebAssembly.Module.exports(module),
      missingHttpHostRejected: true,
      coverage: "compile/link/import inventory only; no HTTP request executed",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "HTTP compile/link imports match host_net and a missing host rejects before guest execution",
);
