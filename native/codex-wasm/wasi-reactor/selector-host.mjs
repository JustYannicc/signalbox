import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";

export async function proveSelector(module) {
  const moduleUrl = process.env.SIGNALBOX_KERNEL_WASI_MODULE
    ? NodeURL.pathToFileURL(process.env.SIGNALBOX_KERNEL_WASI_MODULE)
    : new URL("../../../apps/cloud/src/kernel/KernelWasi.ts", import.meta.url);
  const { createKernelAsyncWasi } = await import(moduleUrl);
  const { KernelFileSystem } = await import(new URL("./KernelFileSystem.ts", moduleUrl));
  const { KernelWakeRegistry } = await import(new URL("./KernelWakeRegistry.ts", moduleUrl));
  const wakes = new KernelWakeRegistry();
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
  let read = true;
  let write = true;
  let hangup = false;
  let closes = 0;
  let subscriptions = 0;
  const resource = () => ({
    ready(direction) {
      return (direction === "read" ? read : write) ? { bytes: 1n, hangup } : undefined;
    },
    subscribe() {
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    close() {
      closes++;
    },
  });
  const first = host.descriptors.register(resource());
  const second = host.descriptors.register(resource());
  const milestones = [];
  const imports = host.wasi.getImportObject();
  imports.host_net = {
    net_send() {
      throw new Error("no real socket I/O allowed");
    },
  };
  imports.signalbox_reactor_probe = {
    try_recv() {
      throw new Error("selector fixture performs no framed receive");
    },
    try_send() {
      throw new Error("selector fixture performs no framed send");
    },
    close(fd) {
      host.descriptors.close(fd);
      return 0;
    },
    record(event) {
      milestones.push(event);
      if (event === 20) {
        read = false;
        write = false;
      } else if (event === 21) read = true;
      else if (event === 22) write = true;
      else if (event === 23) hangup = true;
      else NodeAssert.equal(event, 24);
    },
  };
  try {
    const instance = new WebAssembly.Instance(module, imports);
    await host.wasi.initialize(instance);
    NodeAssert.equal(await host.wasi.run(instance.exports.selector_probe, first, second), 0);
    NodeAssert.deepEqual(milestones, [20, 21, 22, 23, 24]);
    NodeAssert.equal(closes, 2);
    NodeAssert.equal(filesystem.descriptors.has(first), false);
    NodeAssert.equal(filesystem.descriptors.has(second), false);
    NodeAssert.equal(subscriptions, 0);
    NodeAssert.equal(wakes.size, 0);
    console.log(
      JSON.stringify({
        scope: "actual WASI selector and direct Mio IoSourceState",
        cases: [
          "shared-token",
          "both-directions",
          "fully-disarmed-reregister",
          "disarmed-deregister",
          "missing-reregister",
          "empty-no-clock",
          "timed-disarmed",
          "undelivered-direction",
          "hangup",
          "direct-io-wouldblock-rearm",
          "successful-io-stays-disarmed",
        ],
        closes,
      }),
    );
  } finally {
    await host.wasi.close();
    filesystem.dispose();
    wakes.dispose();
  }
}
