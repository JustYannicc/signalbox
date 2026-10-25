// Drives the public #1064 host. No kernel implementation lives in this probe.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const [artifact, adapter] = process.argv.slice(2);
const module = new WebAssembly.Module(await NodeFSP.readFile(artifact));
const imports = WebAssembly.Module.imports(module);
NodeAssert.ok(imports.some((entry) => entry.name === "poll_oneoff"));
NodeAssert.deepEqual(
  imports
    .filter((entry) => entry.module !== "wasi_snapshot_preview1" && entry.module !== "host_net")
    .map((entry) => `${entry.module}.${entry.name}`)
    .sort(),
  [
    "signalbox_reactor_probe.close",
    "signalbox_reactor_probe.record",
    "signalbox_reactor_probe.try_recv",
    "signalbox_reactor_probe.try_send",
  ],
);
// This inherited agentOS std import is unrelated to registration and must not
// be exercised by the readiness fixture. The fixture host throws if called.
NodeAssert.deepEqual(
  imports.filter((entry) => entry.module === "host_net").map((entry) => entry.name),
  ["net_send"],
);
console.log(JSON.stringify({ scope: "minimal WASI registration probe", imports }));
if (!adapter) {
  console.log("Linked only. Runtime needs --host-adapter and the public #1064 kernel module.");
  process.exit(0);
}
NodeAssert.equal(typeof WebAssembly.Suspending, "function");
const { createProbeHost } = await import(NodeURL.pathToFileURL(adapter));

for (const mode of ["delayed", "early", "subscribe-race", "stale"]) {
  const events = [];
  let host;
  let parks = 0;
  host = await createProbeHost({
    mode,
    onLine(line) {
      events.push(line);
    },
    onPark() {
      parks++;
      events.push("host-park");
      NodeAssert.ok(mode === "delayed" || mode === "stale", "already-ready fd must not wait again");
      NodeAssert.ok(events.includes("initialize-sent"), "guest sender must run before host waits");
      NodeAssert.equal(
        host.initializeRequests,
        1,
        "initialize JSON frame must reach the host before park",
      );
      NodeAssert.ok(host.wakes.size > 0, "park must use the request's KernelWakeRegistry");
      queueMicrotask(() => {
        events.push("host-reply");
        host.publish(Uint8Array.of(42));
      });
    },
  });
  NodeAssert.ok(Number.isInteger(host.readyFd) && host.readyFd >= 0 && host.readyFd <= 0x7fffffff);
  if (mode === "early") {
    events.push("host-reply");
    host.publish(Uint8Array.of(42));
  }
  const instance = new WebAssembly.Instance(module, host.imports);
  try {
    await host.initialize(instance);
    const result = await host.run(instance);
    NodeAssert.equal(result, 0);
    for (const expected of [
      "mio-deregistered",
      "negative-fd-rejected",
      "read-pending",
      "initialize-sent",
      "reply-received",
      "tokio-deregistered",
      "fd-closed",
      "probe-complete",
    ]) {
      NodeAssert.ok(events.includes(expected), `missing guest milestone ${expected}`);
    }
    NodeAssert.ok(events.indexOf("read-pending") < events.indexOf("initialize-sent"));
    NodeAssert.ok(events.indexOf("initialize-sent") < events.indexOf("reply-received"));
    NodeAssert.equal(parks, mode === "delayed" || mode === "stale" ? 1 : 0);
    if (mode === "delayed" || mode === "stale") {
      NodeAssert.ok(events.indexOf("initialize-sent") < events.indexOf("host-park"));
      NodeAssert.ok(events.indexOf("host-park") < events.indexOf("host-reply"));
    }
    if (mode === "stale") NodeAssert.ok(events.includes("stale-readiness-cleared"));
    NodeAssert.equal(host.wakes.size, 0, "wake registrations leaked after completion");
    NodeAssert.equal(host.openReadyFds, 0, "transferred ready fd leaked after guest drop");
    NodeAssert.equal(host.resourceCloseCount, 1, "resource must close exactly once");
    NodeAssert.equal(host.initializeRequests, 1);
    console.log(
      JSON.stringify({
        mode,
        parks,
        events,
        wakeTokens: host.wakes.size,
        openReadyFds: host.openReadyFds,
        resourceCloseCount: host.resourceCloseCount,
        initializeRequests: host.initializeRequests,
        scope: "minimal WASI registration runtime",
      }),
    );
  } finally {
    await host.close();
    NodeAssert.equal(host.wakes.size, 0);
    NodeAssert.equal(host.openReadyFds, 0);
  }
}

const { proveSelector } = await import("./selector-host.mjs");
await proveSelector(module);
