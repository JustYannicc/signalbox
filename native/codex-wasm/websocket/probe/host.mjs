import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPeer } from "./resource.mjs";
import { guardPoll } from "./poll-guard.mjs";

const [artifact, kernelDirectory, ...selectedModes] = process.argv.slice(2);
assert.ok(artifact && kernelDirectory, "provide linked probe and immutable public kernel directory");
const kernel = pathToFileURL(kernelDirectory.replace(/\/$/, "") + "/KernelWasi.ts");
const { createKernelAsyncWasi } = await import(kernel);
const { KernelFileSystem } = await import(new URL("./KernelFileSystem.ts", kernel));
const { KernelWakeRegistry } = await import(new URL("./KernelWakeRegistry.ts", kernel));
const module = new WebAssembly.Module(await readFile(artifact));
const moduleImports = WebAssembly.Module.imports(module);
assert.ok(moduleImports.some((entry) => entry.name === "poll_oneoff"));
assert.deepEqual(moduleImports.filter((entry) => entry.module === "signalbox_ws_v1").map((entry) => entry.name).sort(),
  ["ws_close", "ws_drop", "ws_flush", "ws_handshake", "ws_open", "ws_ready", "ws_recv", "ws_send"]);
const milestones = { 1: "open", 2: "handshake", 3: "receive-pending", 4: "initialize", 5: "second", 6: "reply", 7: "closed", 8: "dropped", 9: "done", 10: "canceled", 12: "next-canceled", 13: "send-canceled", 14: "cancel-recovered", 15: "repeated-reply" };

for (const mode of selectedModes.length ? selectedModes : ["delayed", "early", "credit", "flush", "close", "repeated", "cancel", "alias", "cancel-alias"]) {
  const events = [];
  const filesystem = new KernelFileSystem({ mounts: [], stdio: [{},
    { write(bytes) { process.stdout.write(bytes); return bytes.length; } },
    { write(bytes) { process.stderr.write(bytes); return bytes.length; } }] });
  const wakes = new KernelWakeRegistry({ ttlMs: 10_000 });
  const host = createKernelAsyncWasi({ filesystem, wakes });
  assert.equal(host.descriptors.table, filesystem.descriptors);
  const peer = createPeer(mode, host.descriptors, events);
  const imports = host.wasi.getImportObject();
  const polls = guardPoll(imports, (args) => peer.poll(args));
  imports.host_net = { net_send() { throw new Error("host_net must not be used by host WebSocket transport"); } };
  imports.signalbox_ws_v1 = peer.imports;
  imports.signalbox_ws_probe = { record(event) {
    assert.ok(milestones[event], "unknown milestone " + event);
    events.push("guest:" + milestones[event]);
  } };
  const instance = new WebAssembly.Instance(module, imports);
  peer.attach(instance.exports.memory);
  try {
    await host.wasi.initialize(instance);
    const result = await host.wasi.run(instance.exports.probe, ({ cancel: 1, "cancel-alias": 1, "cancel-next": 2, "cancel-send": 3, repeated: 4 })[mode] ?? 0);
    assert.equal(result, 0);
    const evidence = peer.assertComplete();
    assert.equal(wakes.size, 0, "wake token leaked");
    console.log(JSON.stringify({ mode, ...evidence, polls: polls(), events, scope: "real WASI Rust transport with deterministic peer and public shared kernel; not actual WS endpoint" }));
  } catch (error) {
    console.error(JSON.stringify({ mode, polls: polls(), events }));
    throw error;
  } finally {
    await host.wasi.close();
    filesystem.dispose();
    wakes.dispose();
  }
}
