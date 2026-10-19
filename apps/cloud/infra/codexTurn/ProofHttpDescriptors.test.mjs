import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createKernelAsyncWasi } from "../../src/kernel/KernelWasi.ts";
import { createMockHttpAdapter } from "./MockHttpAdapter.mjs";
import { createMockResponses } from "./MockResponses.mjs";

test("mock HTTP sockets share the public WASI binding's descriptor namespace", async () => {
  const filesystem = new KernelFileSystem({ mounts: [] });
  const wakes = new KernelWakeRegistry();
  const binding = createKernelAsyncWasi({ filesystem, wakes });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mock = createMockResponses();
  try {
    NodeAssert.throws(
      () =>
        createMockHttpAdapter({
          memory: () => memory,
          descriptors: filesystem.descriptors,
          mock,
        }),
      /descriptors must expose register, resource, and close/,
    );
    const http = createMockHttpAdapter({
      memory: () => memory,
      descriptors: binding.descriptors,
      mock,
    });
    const before = [...filesystem.descriptors.entries()].map(([fd]) => fd);
    NodeAssert.equal(http.imports.net_socket(1, 6, 0, 16), 0);
    const fd = new DataView(memory.buffer).getUint32(16, true);
    NodeAssert.equal(filesystem.descriptors.has(fd), true);
    const socket = binding.descriptors.resource(fd);
    NodeAssert.equal(socket.ready("read"), undefined);
    NodeAssert.equal(http.imports.net_close(fd), 0);
    NodeAssert.equal(filesystem.descriptors.has(fd), false);
    NodeAssert.deepEqual(
      [...filesystem.descriptors.entries()].map(([entry]) => entry),
      before,
    );
    NodeAssert.throws(() => binding.descriptors.resource(fd), { code: "EBADF" });
  } finally {
    await binding.wasi.close();
    filesystem.dispose();
    wakes.dispose();
  }
});
