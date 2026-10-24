import { expect, it } from "vite-plus/test";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelBrokenPipeError, KernelPipe } from "../../kernel/KernelPipe.ts";
import { KernelProcessSignal } from "../../kernel/KernelProcessSignal.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

const SIZE = 16 * 1024 * 1024;
const PREFIX_SIZE = KERNEL_SYSCALL_MAX_IO_BYTES + 65_536;

it.each(["errno", "signal", "abort"] as const)(
  "preserves accepted bytes and delivers a later %s",
  async (ending) => {
    const controller = new AbortController();
    const cancellation = new Error("Write cancelled");
    const chunks: Uint8Array[] = [];
    let calls = 0;
    const filesystem = new KernelFileSystem({
      mounts: [],
      stdio: [
        {},
        {
          write(source) {
            calls++;
            if (calls > 1) throw new KernelBrokenPipeError();
            chunks.push(source.slice());
            if (ending === "abort") controller.abort(cancellation);
            return source.length;
          },
        },
        {},
      ],
    });
    const host = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: controller.signal,
      sigpipe: ending === "signal" ? "terminate" : "epipe",
    });
    const module = wasmImportReactor(
      "wasi_snapshot_preview1",
      "fd_write",
      ["i32", "i32", "i32", "i32"],
      ["i32"],
    );
    const offsets: number[] = [];
    const child = createChildWasi({
      module,
      args: [],
      env: {},
      syscalls: {
        async call(request) {
          offsets.push(request.transferOffset!);
          return structuredClone(await host.call(structuredClone(request)));
        },
      },
    });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);
    const memory = instance.exports.memory as WebAssembly.Memory;
    const pages = Math.ceil(Math.max(0, 1024 + PREFIX_SIZE - memory.buffer.byteLength) / 65_536);
    if (pages > 0) memory.grow(pages);
    const view = new DataView(memory.buffer);
    view.setUint32(32, 1024, true);
    view.setUint32(36, PREFIX_SIZE, true);
    view.setUint32(16, 0xeeeeeeee, true);
    const source = new Uint8Array(memory.buffer, 1024, PREFIX_SIZE);
    for (let index = 0; index < source.length; index++) source[index] = (index * 37) & 255;
    try {
      const running = child.run(instance.exports.run!, 1, 32, 1, 16);
      if (ending === "errno") {
        expect(await running).toBe(0);
      } else if (ending === "signal") {
        await expect(running).rejects.toBeInstanceOf(KernelProcessSignal);
        await expect(running).rejects.toMatchObject({ signal: 13 });
      } else {
        await expect(running).rejects.toBe(cancellation);
      }
      expect(view.getUint32(16, true)).toBe(
        ending === "errno" ? KERNEL_SYSCALL_MAX_IO_BYTES : 0xeeeeeeee,
      );
      expect(offsets).toEqual([0, KERNEL_SYSCALL_MAX_IO_BYTES]);
      expect(chunks).toEqual([source.slice(0, KERNEL_SYSCALL_MAX_IO_BYTES)]);
      expect(calls).toBe(ending === "abort" ? 1 : 2);
    } finally {
      host.close();
      filesystem.dispose();
    }
  },
);

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
  "preserves the accepted prefix of a 16 MiB write on %s",
  async (interruption) => {
    const fixture = largeIo("fd_write");
    try {
      await fixture.warm();
      const running = fixture.run();
      await fixture.entered.promise;
      expect(fixture.pipe.bufferedBytes).toBe(65_536);
      if (interruption === "abort") fixture.controller.abort();
      else fixture.pipe.closeReader();
      if (interruption === "abort") {
        await expect(running).rejects.toBe(fixture.controller.signal.reason);
      } else {
        expect(await running).toBe(0);
      }
      expect(fixture.view.getUint32(16, true)).toBe(interruption === "abort" ? 0xeeeeeeee : 65_536);
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
