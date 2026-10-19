import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { KernelWebSocketHost } from "../../src/kernel/KernelWebSocketHost.ts";
import { proofEnvironment } from "./ProofWorkspace.mjs";

function requestBytes(url) {
  const encoded = new TextEncoder().encode(url);
  const bytes = new Uint8Array(20 + encoded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 65536, true);
  view.setUint32(8, 262144, true);
  view.setUint32(12, encoded.length, true);
  bytes.set(encoded, 16);
  view.setUint32(16 + encoded.length, 0, true);
  return bytes;
}

test("the configured exec endpoint reaches the kernel route through the guest socket ABI", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const entries = new Map();
  let reached;
  const routed = new Promise((resolve) => {
    reached = resolve;
  });
  const host = new KernelWebSocketHost({
    memory: () => memory,
    descriptors: {
      register(resource) {
        entries.set(4, resource);
        return 4;
      },
      resource: (fd) => entries.get(fd),
      close(fd) {
        entries.get(fd)?.close();
        entries.delete(fd);
      },
    },
    route(input) {
      reached(input.request.url);
      return { status: 418, headers: [], body: new Uint8Array() };
    },
  });
  const rejected = requestBytes("https://loopback.invalid/exec");
  new Uint8Array(memory.buffer, 64, rejected.length).set(rejected);
  NodeAssert.equal(host.imports.ws_open(64, rejected.length, 16), 58);
  NodeAssert.equal(entries.size, 0);

  const accepted = requestBytes(proofEnvironment.CODEX_EXEC_SERVER_URL);
  new Uint8Array(memory.buffer, 64, accepted.length).set(accepted);
  NodeAssert.equal(host.imports.ws_open(64, accepted.length, 16), 0);
  const fd = new DataView(memory.buffer).getUint32(16, true);
  try {
    NodeAssert.equal(await routed, proofEnvironment.CODEX_EXEC_SERVER_URL);
    NodeAssert.equal(entries.size, 1);
  } finally {
    NodeAssert.equal(host.imports.ws_drop(fd), 0);
  }
  NodeAssert.equal(entries.size, 0);
});
