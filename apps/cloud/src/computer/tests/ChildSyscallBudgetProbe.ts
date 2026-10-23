// @effect-diagnostics nodeBuiltinImport:off - measures only owner payload buffers in an isolated Node process.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

const MIB = 1024 * 1024;
const SIZE = 16 * MIB;
const count = Number(NodeProcess.argv[2] ?? 8);
const direction = NodeProcess.argv[3] ?? "write";
const wakes = new KernelWakeRegistry();
const name = direction === "write" ? "fd_write" : "fd_read";
const module = wasmImportReactor(
  "wasi_snapshot_preview1",
  name,
  ["i32", "i32", "i32", "i32"],
  ["i32"],
);

const fixtures = Array.from({ length: count }, () => {
  const pipe = new KernelPipe(wakes);
  const entered = Promise.withResolvers<void>();
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {
        readInto: (bytes) => {
          entered.resolve();
          return pipe.readInto(bytes);
        },
      },
      {
        write: (bytes) => {
          entered.resolve();
          return pipe.writeBlocking(bytes);
        },
      },
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
    sigpipe: "epipe",
  });
  const child = createChildWasi({
    module,
    args: [],
    env: {},
    syscalls: {
      async call(request) {
        // Detach the sender's snapshot. Its Wasm heap is excluded from Node's arrayBuffers,
        // leaving exactly the buffers a separate owner isolate would retain.
        const transfer = [...new Set(request.regions.map((region) => region.bytes.buffer))];
        const response = await host.call(structuredClone(request, { transfer }));
        if (response.kind !== "return") return response;
        return structuredClone(response, {
          transfer: [...new Set(response.regions.map((region) => region.bytes.buffer))],
        });
      },
    },
  });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  const memory = instance.exports.memory as WebAssembly.Memory;
  memory.grow(256);
  const data = new Uint8Array(memory.buffer, 1024, SIZE);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const expected = NodeCrypto.createHash("sha256").update(data).digest("hex");
  if (direction === "read") data.fill(0xa5);
  if (direction === "write") pipe.tryWrite(new Uint8Array(65_536));
  const view = new DataView(memory.buffer);
  async function warm() {
    await host.ready;
    view.setUint32(32, 1024, true);
    view.setUint32(36, 0, true);
    NodeAssert.equal(
      await child.run(instance.exports.run!, direction === "write" ? 1 : 0, 32, 1, 16),
      0,
    );
  }
  async function call(offset: number) {
    view.setUint32(32, 1024 + offset, true);
    view.setUint32(36, SIZE - offset, true);
    NodeAssert.equal(
      await child.run(instance.exports.run!, direction === "write" ? 1 : 0, 32, 1, 16),
      0,
    );
    return view.getUint32(16, true);
  }
  return { pipe, entered, filesystem, host, data, expected, call, warm };
});

for (const fixture of fixtures) await fixture.warm();
globalThis.gc!();
const before = NodeProcess.memoryUsage();
const pending = fixtures.map((fixture) => fixture.call(0));
await Promise.all(fixtures.map((fixture) => fixture.entered.promise));
globalThis.gc!();
const after = NodeProcess.memoryUsage();
const retained = after.arrayBuffers - before.arrayBuffers;
NodeProcess.stdout.write(
  JSON.stringify({
    count,
    direction,
    requestBytes: SIZE,
    retainedArrayBufferBytes: retained,
    externalDelta: after.external - before.external,
  }) + "\n",
);

try {
  NodeAssert.ok(
    retained <= 32 * MIB + count * 128 * 1024,
    `owner retained ${retained} bytes for ${count} blocked ${direction}s`,
  );
  await Promise.all(
    fixtures.map(async (fixture, index) => {
      const transfer = (async () => {
        let offset = await pending[index]!;
        NodeAssert.ok(offset > 0 && offset <= SIZE);
        while (offset < SIZE) {
          const transferred = await fixture.call(offset);
          NodeAssert.ok(transferred > 0 && transferred <= SIZE - offset);
          offset += transferred;
        }
        if (direction === "write") fixture.pipe.closeWriter();
        return offset;
      })();
      if (direction === "write") {
        fixture.pipe.tryReadInto(new Uint8Array(65_536));
        const hash = NodeCrypto.createHash("sha256");
        const chunk = new Uint8Array(65_536);
        let received = 0;
        for (;;) {
          const read = await fixture.pipe.readInto(chunk);
          if (read === 0) break;
          hash.update(chunk.subarray(0, read));
          received += read;
        }
        NodeAssert.equal(received, SIZE);
        NodeAssert.equal(hash.digest("hex"), fixture.expected);
      } else {
        const chunk = new Uint8Array(65_536);
        for (let offset = 0; offset < SIZE; offset += chunk.length) {
          for (let i = 0; i < chunk.length; i++) chunk[i] = (offset + i) % 251;
          let written = 0;
          while (written < chunk.length)
            written += await fixture.pipe.writeBlocking(chunk.subarray(written));
        }
        fixture.pipe.closeWriter();
      }
      NodeAssert.equal(await transfer, SIZE);
      if (direction === "read")
        NodeAssert.equal(
          NodeCrypto.createHash("sha256").update(fixture.data).digest("hex"),
          fixture.expected,
        );
    }),
  );
} finally {
  for (const fixture of fixtures) fixture.pipe.closeReader();
  await Promise.allSettled(pending);
  for (const fixture of fixtures) {
    fixture.host.close();
    fixture.filesystem.dispose();
  }
  wakes.dispose();
}
