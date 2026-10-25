// Test fixture only. Polling and wake ownership come from the public kernel.
import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";

const moduleUrl = process.env.SIGNALBOX_KERNEL_WASI_MODULE
  ? NodeURL.pathToFileURL(process.env.SIGNALBOX_KERNEL_WASI_MODULE)
  : new URL("../../../apps/cloud/src/kernel/KernelWasi.ts", import.meta.url);
const { createKernelAsyncWasi } = await import(moduleUrl);
const { KernelFileSystem } = await import(new URL("./KernelFileSystem.ts", moduleUrl));
const { KernelWakeRegistry } = await import(new URL("./KernelWakeRegistry.ts", moduleUrl));
const milestones = [
  "unused",
  "mio-deregistered",
  "negative-fd-rejected",
  "read-pending",
  "initialize-sent",
  "stale-readiness-cleared",
  "reply-received",
  "tokio-deregistered",
  "fd-closed",
  "probe-complete",
];

export function createProbeHost({ mode, onLine, onPark }) {
  let memory;
  let queue = [];
  let closeCount = 0;
  let initializeRequests = 0;
  let stale = mode === "stale";
  let subscribeRace = mode === "subscribe-race";
  const listeners = new Set();
  const wakes = new KernelWakeRegistry({ ttlMs: 10_000 });
  const wait = wakes.wait.bind(wakes);
  wakes.wait = (...args) => {
    const result = wait(...args);
    onPark();
    return result;
  };
  const resource = {
    ready(direction) {
      NodeAssert.equal(direction, "read");
      return queue.length || stale ? { bytes: BigInt(Math.max(1, queue.length)) } : undefined;
    },
    subscribe(direction, notify) {
      NodeAssert.equal(direction, "read");
      listeners.add(notify);
      if (subscribeRace) {
        subscribeRace = false;
        // Readiness appears inside subscription, before the registry returns
        // its token. The public kernel owns subscribe-before-recheck ordering.
        queue = [42];
        notify();
      }
      return () => listeners.delete(notify);
    },
    tryRecv(target) {
      if (stale) {
        stale = false;
        return -6; // WASI EAGAIN, synchronous and with no waiter installed here.
      }
      if (!queue.length) return -6;
      const count = Math.min(target.length, queue.length);
      target.set(queue.splice(0, count));
      return count;
    },
    trySend(bytes) {
      NodeAssert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      initializeRequests++;
      return bytes.length;
    },
    close() {
      closeCount++;
      listeners.clear();
    },
  };
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {},
      {
        write(bytes) {
          process.stdout.write(bytes);
          return bytes.length;
        },
      },
      {
        write(bytes) {
          process.stderr.write(bytes);
          return bytes.length;
        },
      },
    ],
  });
  const host = createKernelAsyncWasi({ filesystem, wakes });
  NodeAssert.equal(host.descriptors.table, filesystem.descriptors);
  NodeAssert.equal(host.wakes, wakes);
  const readyFd = host.descriptors.register(resource);
  const imports = host.wasi.getImportObject();
  imports.host_net = {
    net_send() {
      throw new Error("probe must not call inherited agentOS net_send");
    },
  };
  imports.signalbox_reactor_probe = {
    try_recv(fd, pointer, length) {
      NodeAssert.equal(fd, readyFd);
      const attached = host.descriptors.resource(fd);
      NodeAssert.equal(attached, resource);
      const result = attached.tryRecv(new Uint8Array(memory.buffer, pointer >>> 0, length >>> 0));
      NodeAssert.equal(typeof result, "number");
      return result;
    },
    try_send(fd, pointer, length) {
      const attached = host.descriptors.resource(fd);
      NodeAssert.equal(attached, resource);
      return attached.trySend(new Uint8Array(memory.buffer, pointer >>> 0, length >>> 0));
    },
    close(fd) {
      host.descriptors.close(fd);
      return 0;
    },
    record(event) {
      NodeAssert.ok(milestones[event], `unknown guest milestone ${event}`);
      onLine(milestones[event]);
    },
  };
  return {
    imports,
    readyFd,
    wakes,
    async initialize(instance) {
      memory = instance.exports.memory;
      await host.wasi.initialize(instance);
    },
    run(instance) {
      return host.wasi.run(instance.exports.probe, readyFd);
    },
    publish(bytes) {
      NodeAssert.equal(closeCount, 0);
      queue.push(...bytes);
      for (const notify of Array.from(listeners)) notify();
    },
    get openReadyFds() {
      return filesystem.descriptors.has(readyFd) ? 1 : 0;
    },
    get resourceCloseCount() {
      return closeCount;
    },
    get initializeRequests() {
      return initializeRequests;
    },
    async close() {
      await host.wasi.close();
      filesystem.dispose();
      wakes.dispose();
      NodeAssert.equal(listeners.size, 0);
      NodeAssert.equal(closeCount, 1);
    },
  };
}
