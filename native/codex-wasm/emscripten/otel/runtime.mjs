import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import { loadCodex } from "./loader.mjs";

const module = new WebAssembly.Module(
  await NodeFSP.readFile(new URL("./engine.wasm", import.meta.url)),
);
const imports = WebAssembly.Module.imports(module);
NodeAssert.equal(
  imports.some(({ name }) => /pthread|thread_spawn|futex/.test(name)),
  false,
);
const network = imports.filter((entry) => entry.module === "host_net");
NodeAssert.deepEqual(network.map(({ name }) => name).sort(), [
  "net_close",
  "net_connect",
  "net_recv",
  "net_send",
  "net_setsockopt",
  "net_socket",
  "net_tls_connect",
]);
const lines = [];
let socketCalls = 0;
const host_net = Object.fromEntries(
  network.map(({ name }) => [
    name,
    () => {
      NodeAssert.equal(name, "net_socket", `unexpected operation after rejected socket: ${name}`);
      socketCalls++;
      return 52; // The reused AgentOS ABI defines WASI NOSYS as 52.
    },
  ]),
);
const loaded = await loadCodex(module, {
  imports: { host_net },
  print: (line) => lines.push(line),
  printErr: (line) => lines.push(`stderr: ${line}`),
});
await loaded.run();
NodeAssert.equal(socketCalls, 1);
for (const expected of [
  "otel-default-span-client-ok",
  "otel-default-log-client-ok",
  "otel-default-metric-client-ok",
  "otel-host-net-rejection-ok",
  "otel-probe-ok",
])
  NodeAssert.ok(lines.includes(expected), JSON.stringify(lines));
const evidence = {
  jspi: true,
  imports,
  socketCalls,
  lines,
  coverage:
    "Public default HTTP exporter construction and injected host_net socket rejection. No HTTP, TLS, timeout or scheduling parity proved.",
};
await NodeFSP.writeFile(
  new URL("./runtime-evidence.json", import.meta.url),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
