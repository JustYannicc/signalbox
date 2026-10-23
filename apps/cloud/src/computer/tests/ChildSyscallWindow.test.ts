import { expect, it } from "vite-plus/test";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

const SIZE = 16 * 1024 * 1024;

function largeIo(name: "fd_read" | "fd_write", sigpipe: "epipe" | "terminate" = "epipe") {
  const wakes = new KernelWakeRegistry();
  const pipe = new KernelPipe(wakes);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {
        readInto: (target) => {
          entered.resolve();
          return pipe.readInto(target, { signal: controller.signal });
        },
      },
      {
        write: (source) => {
          entered.resolve();
          return pipe.writeBlocking(source, { signal: controller.signal });
        },
      },
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    signal: controller.signal,
    args: [],
    env: {},
    sigpipe,
  });
  const module = wasmImportReactor(
    "wasi_snapshot_preview1",
    name,
    ["i32", "i32", "i32", "i32"],
    ["i32"],
  );
  const child = createChildWasi({
    module,
    args: [],
    env: {},
    syscalls: {
      call: async (request) => structuredClone(await host.call(structuredClone(request))),
    },
  });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  const memory = instance.exports.memory as WebAssembly.Memory;
  memory.grow(256);
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer, 1024, SIZE).fill(0xa5);
  const run = () => child.run(instance.exports.run!, name === "fd_read" ? 0 : 1, 32, 1, 16);
  return {
    pipe,
    controller,
    bytes,
    view,
    entered,
    async warm() {
      view.setUint32(32, 1024, true);
      view.setUint32(36, 0, true);
      expect(await run()).toBe(0);
      view.setUint32(36, SIZE, true);
      view.setUint32(16, 0xeeeeeeee, true);
    },
    run,
    close() {
      pipe.closeReader();
      pipe.closeWriter();
      host.close();
      filesystem.dispose();
      wakes.dispose();
    },
  };
}

it.each(["abort", "epipe"] as const)(
  "reports only the accepted prefix of a 16 MiB write on %s",
  async (interruption) => {
    const fixture = largeIo("fd_write");
    try {
      await fixture.warm();
      const running = fixture.run();
      await fixture.entered.promise;
      expect(fixture.pipe.bufferedBytes).toBe(65_536);
      if (interruption === "abort") fixture.controller.abort();
      else fixture.pipe.closeReader();
      expect(await running).toBe(0);
      expect(fixture.view.getUint32(16, true)).toBe(65_536);
      if (interruption === "abort") {
        const received = new Uint8Array(65_536);
        expect(fixture.pipe.tryReadInto(received)).toBe(received.length);
        expect(received.every((byte) => byte === 0xa5)).toBe(true);
      }
    } finally {
      fixture.close();
    }
  },
);

it.each(["epipe", "terminate"] as const)(
  "preserves %s on a 16 MiB write to a closed pipe",
  async (sigpipe) => {
    const fixture = largeIo("fd_write", sigpipe);
    try {
      await fixture.warm();
      fixture.pipe.closeReader();
      if (sigpipe === "epipe") expect(await fixture.run()).toBe(64);
      else await expect(fixture.run()).rejects.toMatchObject({ signal: 13 });
      expect(fixture.view.getUint32(16, true)).toBe(0xeeeeeeee);
    } finally {
      fixture.close();
    }
  },
);

it.each(["abort", "eof"] as const)(
  "preserves untouched output bytes on a 16 MiB read ending in %s",
  async (ending) => {
    const fixture = largeIo("fd_read");
    try {
      await fixture.warm();
      const running = fixture.run();
      await fixture.entered.promise;
      if (ending === "abort") fixture.controller.abort();
      else fixture.pipe.closeWriter();
      expect(await running).toBe(ending === "abort" ? 11 : 0);
      expect(fixture.view.getUint32(16, true)).toBe(ending === "abort" ? 0xeeeeeeee : 0);
      expect(fixture.bytes.every((byte) => byte === 0xa5)).toBe(true);
    } finally {
      fixture.close();
    }
  },
);
