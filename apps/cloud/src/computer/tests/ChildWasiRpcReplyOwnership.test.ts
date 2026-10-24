import { describe, expect, it } from "vite-plus/test";
import { createChildWasi } from "../ChildWasi.ts";
import { childWasiIo } from "../ChildWasiIo.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import { disposable, importReactor, instantiateImports } from "./ChildRpcReplyTestFixture.ts";

describe("ChildWasi RPC reply ownership", () => {
  it("copies fd_fdstat_get output before disposing the received reply", async () => {
    const module = importReactor("wasi_snapshot_preview1", "fd_fdstat_get", 2);
    const output = Uint8Array.from({ length: 24 }, (_, index) => index + 1);
    const probe = disposable({
      kind: "return" as const,
      value: 0,
      regions: [{ pointer: 64, bytes: output }],
    });
    const child = createChildWasi({
      module,
      args: [],
      env: {},
      syscalls: {
        async call() {
          return probe.reply;
        },
      },
    });
    const guest = instantiateImports(module, child);

    await expect(child.run(guest.instance.exports.run!, 3, 64)).resolves.toBe(0);
    expect(new Uint8Array(guest.memory.buffer, 64, output.byteLength)).toEqual(output);
    expect(probe.count()).toBe(1);
    expect(probe.receiverWasReply()).toBe(true);
  });

  it("disposes a return reply when WASI output validation throws", async () => {
    const module = importReactor("wasi_snapshot_preview1", "fd_fdstat_get", 2);
    const probe = disposable({
      kind: "return" as const,
      value: 0,
      regions: [{ pointer: 65_536, bytes: new Uint8Array([1]) }],
    });
    const child = createChildWasi({
      module,
      args: [],
      env: {},
      syscalls: {
        async call() {
          return probe.reply;
        },
      },
    });
    const guest = instantiateImports(module, child);

    await expect(child.run(guest.instance.exports.run!, 3, 64)).rejects.toThrow(
      "Invalid syscall memory response regions",
    );
    expect(probe.count()).toBe(1);
  });

  it("consumes terminal exit and signal replies before returning or throwing", async () => {
    for (const response of [
      disposable({ kind: "exit" as const, code: 23 }),
      disposable({ kind: "signal" as const, signal: 15 as const }),
    ]) {
      const module = importReactor("wasi_snapshot_preview1", "fd_fdstat_get", 2);
      const child = createChildWasi({
        module,
        args: [],
        env: {},
        syscalls: {
          async call() {
            return response.reply;
          },
        },
      });
      const guest = instantiateImports(module, child);

      if (response.reply.kind === "exit") {
        await expect(child.run(guest.instance.exports.run!, 3, 64)).resolves.toBe(23);
      } else {
        await expect(child.run(guest.instance.exports.run!, 3, 64)).rejects.toMatchObject({
          signal: 15,
        });
      }
      expect(response.count()).toBe(1);
    }
  });

  it("propagates an aborted WASI RPC when no reply arrives", async () => {
    const module = importReactor("wasi_snapshot_preview1", "fd_fdstat_get", 2);
    const abort = new DOMException("operation aborted", "AbortError");
    const child = createChildWasi({
      module,
      args: [],
      env: {},
      syscalls: {
        async call() {
          throw abort;
        },
      },
    });
    const guest = instantiateImports(module, child);

    await expect(child.run(guest.instance.exports.run!, 3, 64)).rejects.toBe(abort);
  });

  it("applies an fd_read reply before disposing it", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new DataView(memory.buffer);
    table.setUint32(32, 128, true);
    table.setUint32(36, 4, true);
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, 4, true);
    const output = Uint8Array.from([0x00, 0x80, 0xff, 0x42]);
    const probe = disposable({
      kind: "return" as const,
      value: 0,
      regions: [
        { pointer: 16, bytes: count },
        { pointer: 128, bytes: output },
      ],
    });

    await expect(
      childWasiIo({
        name: "fd_read",
        args: [0, 32, 1, 16],
        memory,
        syscalls: {
          async call() {
            return probe.reply;
          },
        },
      }),
    ).resolves.toBe(0);
    expect(new DataView(memory.buffer).getUint32(16, true)).toBe(4);
    expect(new Uint8Array(memory.buffer, 128, 4)).toEqual(output);
    expect(probe.count()).toBe(1);
  });

  it("returns copied terminal fields from childWasiIo, not the disposed reply", async () => {
    const probes = [
      disposable({ kind: "signal" as const, signal: 15 as const }),
      disposable({ kind: "exit" as const, code: 23 }),
    ];

    for (const probe of probes) {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const table = new DataView(memory.buffer);
      table.setUint32(32, 128, true);
      table.setUint32(36, 4, true);
      const result = await childWasiIo({
        name: "fd_read",
        args: [0, 32, 1, 16],
        memory,
        syscalls: {
          async call() {
            return probe.reply;
          },
        },
      });

      expect(result).toEqual(
        probe.reply.kind === "signal" ? { kind: "signal", signal: 15 } : { kind: "exit", code: 23 },
      );
      expect(result).not.toBe(probe.reply);
      expect(result !== undefined && typeof result !== "number" && Symbol.dispose in result).toBe(
        false,
      );
      expect(probe.count()).toBe(1);
    }
  });

  it("disposes a lazy window reply when response validation throws", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new DataView(memory.buffer);
    table.setUint32(32, 128, true);
    table.setUint32(36, 4, true);
    const probe = disposable({
      kind: "return" as const,
      value: 0,
      regions: [{ pointer: 4096, bytes: new Uint8Array([1]) }],
    });

    await expect(
      childWasiIo({
        name: "fd_read",
        args: [0, 32, 1, 16],
        memory,
        syscalls: {
          async call() {
            return probe.reply;
          },
        },
      }),
    ).rejects.toThrow("Invalid syscall memory response regions");
    expect(probe.count()).toBe(1);
  });

  it("disposes every lazy window reply, including the reply whose count is invalid", async () => {
    const memory = new WebAssembly.Memory({ initial: 33 });
    const table = new DataView(memory.buffer);
    table.setUint32(32, 128, true);
    table.setUint32(36, KERNEL_SYSCALL_MAX_IO_BYTES + 1, true);
    const firstCount = new Uint8Array(4);
    new DataView(firstCount.buffer).setUint32(0, KERNEL_SYSCALL_MAX_IO_BYTES, true);
    const secondCount = new Uint8Array(4);
    new DataView(secondCount.buffer).setUint32(0, 2, true);
    const first = disposable({
      kind: "return" as const,
      value: 0,
      io: { descriptor: "file" as const, nonblocking: false },
      regions: [
        { pointer: 16, bytes: firstCount },
        { pointer: 128, bytes: new Uint8Array(KERNEL_SYSCALL_MAX_IO_BYTES) },
      ],
    });
    const second = disposable({
      kind: "return" as const,
      value: 0,
      io: { descriptor: "file" as const, nonblocking: false },
      regions: [
        { pointer: 16, bytes: secondCount },
        {
          pointer: 128 + KERNEL_SYSCALL_MAX_IO_BYTES,
          bytes: new Uint8Array([0x7f]),
        },
      ],
    });
    const replies = [first.reply, second.reply];
    let calls = 0;

    await expect(
      childWasiIo({
        name: "fd_read",
        args: [0, 32, 1, 16],
        memory,
        syscalls: {
          async call() {
            return replies[calls++]!;
          },
        },
      }),
    ).rejects.toThrow("Invalid syscall transfer count");
    expect(calls).toBe(2);
    expect(first.count()).toBe(1);
    expect(second.count()).toBe(1);
  });

  it("propagates an aborted lazy syscall when no reply arrives", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new DataView(memory.buffer);
    table.setUint32(32, 128, true);
    table.setUint32(36, 4, true);
    const abort = new DOMException("operation aborted", "AbortError");

    await expect(
      childWasiIo({
        name: "fd_read",
        args: [0, 32, 1, 16],
        memory,
        syscalls: {
          async call() {
            throw abort;
          },
        },
      }),
    ).rejects.toBe(abort);
  });
});
