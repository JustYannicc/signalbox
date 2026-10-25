// Synthetic adapter proof only. No filesystem, sockets, processes, PTYs or signals.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { loadCodex } from "./loader.mjs";
import { createEmscriptenHost } from "./host.mjs";

const kernelUrl = process.env.SIGNALBOX_KERNEL_ABI_MODULE
  ? NodeURL.pathToFileURL(process.env.SIGNALBOX_KERNEL_ABI_MODULE)
  : new URL("../../../apps/cloud/src/kernel/KernelAbi.ts", import.meta.url);
const { KernelWakeRegistry, attemptKernelOperation } = await import(kernelUrl);
const module = new WebAssembly.Module(
  await NodeFSP.readFile(new URL("./engine.wasm", import.meta.url)),
);
const imports = WebAssembly.Module.imports(module);
NodeAssert.deepEqual(
  imports
    .filter((entry) => entry.module === "signalbox_emscripten")
    .map((entry) => entry.name)
    .sort(),
  ["reactor_drop", "reactor_new", "reactor_poll", "reactor_wake", "runtime_require"],
);
NodeAssert.equal(
  imports.some((entry) => /pthread|thread_spawn|futex/.test(entry.name)),
  false,
);

async function run(mode, omitPoll = false) {
  let memory;
  let suspended = 0,
    resumed = 0,
    dropped = 0;
  const lines = [],
    required = [];
  const wakes = new KernelWakeRegistry({ ttlMs: 10_000 });
  const wait = wakes.wait.bind(wakes);
  wakes.wait = async (...args) => {
    const result = await wait(...args);
    resumed++;
    lines.push("host-resumed");
    return result;
  };
  const bridge = createEmscriptenHost({
    wakes,
    attemptKernelOperation(...args) {
      const result = attemptKernelOperation(...args);
      if (result.status === "would_block") {
        suspended++;
        lines.push("host-suspended");
      }
      return result;
    },
    // A deliberate test double. Success proves only exercised runtime paths.
    capabilities: mode === "unavailable" ? 1 : 31,
  });
  const adapter = bridge.imports.signalbox_emscripten;
  const host = {
    ...adapter,
    runtime_require(mask) {
      required.push(mask);
      return mode === "invalid-require" ? -1 : adapter.runtime_require(mask);
    },
    reactor_drop(handle) {
      dropped++;
      return adapter.reactor_drop(handle);
    },
    reactor_poll(...args) {
      if (mode === "negative-errno") return -1;
      if (mode === "interrupted") return 27;
      if (mode === "invalid-count") {
        new DataView(memory.buffer).setUint32(args[4] >>> 0, 1, true);
        return 0;
      }
      return adapter.reactor_poll(...args);
    },
  };
  if (omitPoll) delete host.reactor_poll;
  try {
    const loaded = await loadCodex(module, {
      imports: { signalbox_emscripten: host },
      suspendingImports: omitPoll ? [] : bridge.suspendingImports,
      arguments: [mode],
      attach(instance) {
        bridge.attach(instance);
        memory = Object.values(instance.exports).find(
          (value) => value instanceof WebAssembly.Memory,
        );
        NodeAssert.ok(memory.buffer instanceof ArrayBuffer);
      },
      print: (line) => lines.push(line),
      printErr: (line) => lines.push(`stderr: ${line}`),
    });
    await loaded.run();
    if (mode === "runtime") {
      const seen = new Set(lines);
      for (const expected of [
        "inline-blocking-limitation-confirmed",
        "tokio-timer-before",
        "tokio-timer-after",
        "mio-wake-before-poll-ok",
        "mio-timer-before",
        "mio-timer-after",
        "synthetic-runtime-proof-ok",
      ]) {
        NodeAssert.ok(seen.has(expected), `missing guest milestone ${expected}`);
      }
      for (const [before, after] of [
        ["tokio-timer-before", "tokio-timer-after"],
        ["mio-timer-before", "mio-timer-after"],
      ]) {
        const during = new Set(lines.slice(lines.indexOf(before), lines.indexOf(after)));
        NodeAssert.ok(during.has("host-suspended"), `no JSPI suspension during ${before}`);
        NodeAssert.ok(during.has("host-resumed"), `no JSPI resumption during ${before}`);
      }
      NodeAssert.ok(suspended >= 2);
      NodeAssert.equal(resumed, suspended);
      NodeAssert.ok(dropped >= 1);
      NodeAssert.ok(required.length >= 1);
    } else if (mode === "unavailable" || mode === "invalid-require") {
      NodeAssert.ok(lines.includes("host-rejection-ok"));
      NodeAssert.equal(bridge.activeReactors, 0);
    } else {
      NodeAssert.ok(lines.includes("poll-error-ok"));
      NodeAssert.equal(bridge.activeReactors, 0);
    }
    NodeAssert.ok(required.every((mask) => mask === 31));
    console.log(
      JSON.stringify({ mode, synthetic: true, suspended, resumed, dropped, required, lines }),
    );
  } finally {
    bridge.dispose();
    NodeAssert.equal(bridge.activeReactors, 0);
    NodeAssert.equal(wakes.size, 0);
    wakes.dispose();
  }
}

await NodeAssert.rejects(
  run("runtime", true),
  /Missing Codex kernel import: signalbox_emscripten.reactor_poll/,
);
for (const mode of [
  "unavailable",
  "invalid-require",
  "invalid-count",
  "interrupted",
  "negative-errno",
  "runtime",
]) {
  await run(mode);
}
console.log(
  "synthetic JSPI adapter proof passed; Codex/PTY/process/network/signal behavior unverified",
);
