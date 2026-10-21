import * as NodeAssert from "node:assert/strict";
import * as NodeWorkerThreads from "node:worker_threads";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { fixture } from "./fixture.ts";

const f = fixture();
const originalFetch = globalThis.fetch;
let dnsRequests = 0;
globalThis.fetch = async (resource, init) => {
  const url = new URL(String(resource));
  NodeAssert.equal(url.origin, "https://cloudflare-dns.com");
  NodeAssert.equal(url.searchParams.get("type"), "1");
  NodeAssert.ok(init?.signal);
  dnsRequests++;
  return Response.json({
    Status: 0,
    Answer: [{ name: "example.test.", type: 1, TTL: 90, data: "192.0.2.9" }],
  });
};
try {
  const process = launchNodeHarnessProcess({
    ...f.input,
    nativeModules: NodeWorkerThreads.workerData ? { dns: {}, "dns/promises": {} } : {},
    loadPackages: async () => ({}),
    loadRelease: async (bridge) => ({
      async launch() {
        const dns = bridge.require("dns");
        const promises = bridge.require("dns/promises");
        NodeAssert.equal(bridge.require("node:dns"), dns);
        NodeAssert.equal(bridge.require("node:dns/promises"), promises);
        NodeAssert.equal(Reflect.get(dns, "promises"), promises);
        NodeAssert.deepEqual(await Reflect.get(promises, "lookup")("127.0.0.1"), {
          address: "127.0.0.1",
          family: 4,
        });
        NodeAssert.deepEqual(await Reflect.get(promises, "lookup")("localhost", { family: 6 }), {
          address: "::1",
          family: 6,
        });
        const fs = bridge.require("fs");
        Reflect.get(fs, "mkdirSync")("/etc");
        Reflect.get(fs, "writeFileSync")("/etc/hosts", "192.0.2.17 guest-private alias\n");
        NodeAssert.deepEqual(await Reflect.get(promises, "lookup")("alias"), {
          address: "192.0.2.17",
          family: 4,
        });
        NodeAssert.equal(dnsRequests, 0);
        NodeAssert.deepEqual(
          await Reflect.get(promises, "resolve4")("example.test", { ttl: true }),
          [{ address: "192.0.2.9", ttl: 90 }],
        );
        NodeAssert.equal(dnsRequests, 1);
        Reflect.get(bridge.require("process"), "exit")(0);
      },
    }),
  });
  try {
    NodeAssert.deepEqual(await process.exited, { exitCode: 0, signal: 0, coreDumped: false });
  } finally {
    await process.dispose();
  }
} finally {
  globalThis.fetch = originalFetch;
  await f.close();
}
