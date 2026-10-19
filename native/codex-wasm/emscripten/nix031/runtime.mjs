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
const lines = [];
const loaded = await loadCodex(module, {
  print: (line) => lines.push(line),
  printErr: (line) => lines.push(`stderr: ${line}`),
});
await loaded.run();
for (const expected of [
  "signal-wait-enosys-ok",
  "signal-mask-enosys-and-noop-ok",
  "faccessat-existing-missing-errno-ok",
  "faccessat-relative-dirfd-eaccess-ok",
  "nix031-probe-ok",
]) {
  NodeAssert.ok(lines.includes(expected), JSON.stringify(lines));
}
console.log(
  JSON.stringify({
    jspi: true,
    lines,
    coverage: "nix 0.31.3 compatibility only; no OS signals, PTYs or processes",
  }),
);
