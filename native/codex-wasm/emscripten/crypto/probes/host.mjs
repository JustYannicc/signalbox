// Synthetic Node fixture host. Only this test compiles the fixture bytes.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import { loadCodex } from "./loader.mjs";

const module = new WebAssembly.Module(
  await NodeFSP.readFile(new URL("./engine.wasm", import.meta.url)),
);
WebAssembly.Module = new Proxy(WebAssembly.Module, {
  construct() {
    throw new Error("unexpected dynamic Wasm Module construction");
  },
});
const nativeCrypto = globalThis.crypto;
NodeAssert.equal(typeof nativeCrypto?.getRandomValues, "function");
for (const name of ["compile", "compileStreaming", "instantiate", "instantiateStreaming"]) {
  WebAssembly[name] = () => {
    throw new Error(`unexpected dynamic Wasm API: ${name}`);
  };
}
globalThis.fetch = () => {
  throw new Error("unexpected fetch");
};
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

async function run(mode) {
  const segments = [];
  const lines = [];
  let active;
  let delegated = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(view) {
        if (active) {
          active.chunks.push(view.byteLength);
          if (mode === "entropy-throws") throw new Error("test-entropy-unavailable");
        }
        delegated++;
        return nativeCrypto.getRandomValues(view);
      },
    },
  });
  try {
    const loaded = await loadCodex(module, {
      print(line) {
        lines.push(line);
        const begin = /^(ring|rustls)-begin:(\d+)$/.exec(line);
        if (begin) {
          NodeAssert.equal(active, undefined);
          active = { caller: begin[1], size: Number(begin[2]), chunks: [] };
          segments.push(active);
        }
        const end = /^(ring|rustls)-end:(\d+)$/.exec(line);
        if (end) {
          NodeAssert.equal(active?.caller, end[1]);
          NodeAssert.equal(active.size, Number(end[2]));
          const expected = [];
          for (let left = active.size; left > 0; left -= 256) expected.push(Math.min(left, 256));
          NodeAssert.deepEqual(active.chunks, expected);
          active = undefined;
        }
      },
      printErr(line) {
        lines.push(`stderr: ${line}`);
      },
    });
    if (mode === "entropy-throws") {
      await NodeAssert.rejects(loaded.run(), /test-entropy-unavailable/);
      NodeAssert.equal(active?.caller, "ring");
      NodeAssert.equal(active.size, 1);
      NodeAssert.deepEqual(active.chunks, [1]);
      NodeAssert.ok(!lines.includes("ring-end:1"));
      NodeAssert.ok(!lines.includes("ring-entropy-probe-ok"));
    } else {
      await loaded.run();
      NodeAssert.equal(active, undefined);
      NodeAssert.ok(lines.includes("ring-entropy-probe-ok"));
      NodeAssert.deepEqual(
        segments.map(({ caller, size }) => [caller, size]),
        [
          ["ring", 0],
          ["ring", 1],
          ["ring", 256],
          ["ring", 257],
          ["ring", 65_537],
          ["rustls", 32],
        ],
      );
      NodeAssert.ok(delegated >= 262);
    }
    console.log(JSON.stringify({ mode, syntheticNodeHost: true, delegated, segments, lines }));
  } finally {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
}

await run("real-webcrypto");
await run("entropy-throws");
console.log("Ring entropy boundary passed; TLS and full Codex turns remain unverified");
