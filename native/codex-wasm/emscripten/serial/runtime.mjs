import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import { loadCodex } from "./loader.mjs";

const module = new WebAssembly.Module(
  await NodeFSP.readFile(new URL("./engine.wasm", import.meta.url)),
);
const imports = WebAssembly.Module.imports(module);
NodeAssert.equal(
  imports.some(({ name }) => /ioctl|pthread|thread_spawn|futex/.test(name)),
  false,
);
NodeAssert.equal(
  imports.some(({ module }) => module.startsWith("signalbox")),
  false,
);
const lines = [];
const loaded = await loadCodex(module, {
  print: (line) => lines.push(line),
  printErr: (line) => lines.push(`stderr: ${line}`),
});
await loaded.run();
for (const expected of [
  "serial-break-true-unsupported-ok",
  "serial-break-false-unsupported-ok",
  "serial-public-owned-fd-ok",
  "serial-probe-ok",
]) {
  NodeAssert.ok(lines.includes(expected), JSON.stringify(lines));
}
console.log(
  JSON.stringify({
    jspi: true,
    ioctlImports: 0,
    lines,
    coverage: "serial break rejection only; no serial device or PTY support claimed",
  }),
);
