import { describe, expect, it, vi } from "vite-plus/test";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import {
  KERNEL_SYSCALL_MAX_IO_BYTES,
  type KernelSyscallRequest,
} from "../../kernel/KernelSyscallPort.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const MIB = 1024 * 1024;

describe("directional child WASI transfers", () => {
  it.each(["short", "eof", "error", "next-error"] as const)(
    "preserves untouched bytes on a %s read",
    async (mode) => {
      let calls = 0;
      const filesystem = new KernelFileSystem({
        mounts: [],
        stdio: [
          {
            readInto(target) {
              calls++;
              if (mode === "error" || (mode === "next-error" && calls === 2))
                throw Object.assign(new Error("read failed"), { code: "EIO" });
              const count = mode === "eof" ? 0 : mode === "short" ? 3 : target.length;
              target.fill(0, 0, count);
              return count;
            },
          },
          {},
          {},
        ],
      });
      const host = createKernelSyscallHost({
        filesystem,
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      const module = wasmImportReactor(
        "wasi_snapshot_preview1",
        "fd_read",
        ["i32", "i32", "i32", "i32"],
        ["i32"],
      );
      let returned: readonly { pointer: number; bytes: Uint8Array }[] = [];
      const child = createChildWasi({
        module,
        args: [],
        env: {},
        syscalls: {
          async call(request) {
            const response = await host.call(structuredClone(request));
            if (response.kind === "return") returned = response.regions;
            return structuredClone(response);
          },
        },
      });
      const instance = new WebAssembly.Instance(module, child.imports);
      child.bind(instance);
      const memory = instance.exports.memory as WebAssembly.Memory;
      memory.grow(2);
      const view = new DataView(memory.buffer);
      view.setUint32(32, 1024, true);
      view.setUint32(36, 0, true);
      expect(await child.run(instance.exports.run!, 0, 32, 1, 16)).toBe(0);
      returned = [];
      view.setUint32(16, 0xeeeeeeee, true);
      view.setUint32(32, 1024, true);
      view.setUint32(36, 128 * 1024, true);
      const destination = new Uint8Array(memory.buffer, 1024, 128 * 1024);
      destination.fill(0xa5);
      const written = mode === "short" ? 3 : mode === "next-error" ? 65_536 : 0;
      const failed = mode === "error";
      try {
        expect(await child.run(instance.exports.run!, 0, 32, 1, 16)).toBe(failed ? 29 : 0);
        expect(view.getUint32(16, true)).toBe(failed ? 0xeeeeeeee : written);
        expect(destination.subarray(0, written).every((b) => b === 0)).toBe(true);
        expect(destination.subarray(written).every((b) => b === 0xa5)).toBe(true);
        expect(returned.map((r) => [r.pointer, r.bytes.length])).toEqual([
          ...(!failed ? [[16, 4]] : []),
          ...(written ? [[1024, written]] : []),
        ]);
        expect(calls).toBe(1);
        if (mode === "next-error") {
          view.setUint32(16, 0xeeeeeeee, true);
          expect(await child.run(instance.exports.run!, 0, 32, 1, 16)).toBe(29);
          expect(view.getUint32(16, true)).toBe(0xeeeeeeee);
          expect(calls).toBe(2);
          expect(destination.subarray(0, written).every((b) => b === 0)).toBe(true);
          expect(destination.subarray(written).every((b) => b === 0xa5)).toBe(true);
        }
      } finally {
        host.close();
        filesystem.dispose();
      }
    },
  );

  it.each([
    ["fd_read", MIB, 65_536],
    ["fd_write", MIB, MIB],
    ["fd_read", 17 * MIB, 65_536],
    ["fd_write", 17 * MIB, 17 * MIB],
    ["fd_write", MIB, 3],
  ] as const)(
    "%s with %i bytes and a %i-byte backend limit completes the guest call without extra payload RPCs",
    async (name, size, backendLimit) => {
      let accepted = 0;
      let writes = 0;
      let exact = true;
      const filesystem = new KernelFileSystem({
        mounts: [],
        stdio: [
          {
            readInto: (target) => {
              target.fill(0x5a);
              return target.length;
            },
          },
          {
            write: (source) => {
              const count = writes++ === 0 ? Math.min(source.length, backendLimit) : source.length;
              exact &&= source
                .subarray(0, count)
                .every((byte, index) => byte === (((accepted + index) * 37) & 255));
              accepted += count;
              return count;
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
      });
      const module = wasmImportReactor(
        "wasi_snapshot_preview1",
        name,
        ["i32", "i32", "i32", "i32"],
        ["i32"],
      );
      let sent = 0;
      let received = 0;
      let compared = 0;
      let payload = 0;
      const limit = KERNEL_SYSCALL_MAX_IO_BYTES;
      const requests: KernelSyscallRequest[] = [];
      const child = createChildWasi({
        module,
        args: [],
        env: {},
        syscalls: {
          async call(request) {
            requests.push(request);
            const amount = Math.min(size - (request.transferOffset ?? 0), limit);
            const region = request.regions.find(
              (region) => region.pointer === 1024 + (request.transferOffset ?? 0),
            );
            if (region !== undefined) {
              expect(region.length ?? region.bytes.length).toBe(amount);
              if (name === "fd_write") payload += amount;
            }
            const copy = structuredClone(request);
            for (const region of copy.regions) {
              sent += region.bytes.byteLength;
              const bytes = region.bytes;
              // Count scalar reads of the original owner snapshot, excluding native copies.
              Object.assign(region, {
                bytes: new Proxy(bytes, {
                  get(target, key) {
                    if (typeof key === "string" && /^\d+$/.test(key)) compared++;
                    const value: unknown = Reflect.get(target, key, target);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                }),
              });
            }
            const response = await host.call(copy);
            if (response.kind === "return") {
              received += response.regions.reduce((n, r) => n + r.bytes.length, 0);
            }
            return structuredClone(response);
          },
        },
      });
      const instance = new WebAssembly.Instance(module, child.imports);
      child.bind(instance);
      const memory = instance.exports.memory as WebAssembly.Memory;
      memory.grow(size / 65_536);
      const view = new DataView(memory.buffer);
      view.setUint32(32, 1024, true);
      view.setUint32(36, 0, true);
      expect(await child.run(instance.exports.run!, name === "fd_read" ? 0 : 1, 32, 1, 16)).toBe(0);
      sent = 0;
      received = 0;
      compared = 0;
      payload = 0;
      requests.length = 0;
      view.setUint32(32, 1024, true);
      view.setUint32(36, size, true);
      const destination = new Uint8Array(memory.buffer, 1024, size);
      if (name === "fd_read") destination.fill(0xa5);
      else
        for (let index = 0; index < destination.length; index++)
          destination[index] = (index * 37) & 255;
      try {
        const count = name === "fd_read" ? 65_536 : size;
        expect(await child.run(instance.exports.run!, name === "fd_read" ? 0 : 1, 32, 1, 16)).toBe(
          0,
        );
        expect(view.getUint32(16, true)).toBe(count);
        expect(accepted).toBe(name === "fd_write" ? size : 0);
        expect(exact).toBe(true);
        expect(
          destination
            .subarray(0, count)
            .every((b, index) => b === (name === "fd_read" ? 0x5a : (index * 37) & 255)),
        ).toBe(true);
        expect(destination.subarray(count).every((b) => b === 0xa5)).toBe(true);
        expect(sent).toBe((name === "fd_read" ? 0 : payload) + 8 * requests.length);
        expect(received).toBe((name === "fd_read" ? count : 0) + 4 * requests.length);
        expect(requests[0]?.transferOffset).toBe(0);
        expect(
          requests.every(
            (request) => request.args[1] === 32 && request.args[2] === 1 && request.args[3] === 16,
          ),
        ).toBe(true);
        if (name === "fd_read") expect(requests).toHaveLength(1);
        else expect(requests.length).toBeGreaterThanOrEqual(Math.ceil(size / MIB));
        if (backendLimit === 3) {
          expect(requests).toHaveLength(Math.ceil(size / MIB));
        }
        expect(compared).toBe(0);
      } finally {
        host.close();
        filesystem.dispose();
      }
    },
  );

  it.each(["fd_pread", "fd_pwrite"] as const)(
    "continues %s across aliased vectors at an exact bigint offset",
    async (name) => {
      const fixture = createTestFilesystem();
      const fd = fixture.filesystem.open(
        "/positioned",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      const descriptor = fixture.filesystem.descriptors.get(fd);
      const storage = descriptor.mount?.storage;
      if (storage === undefined) throw new Error("Expected mounted storage");
      const base = 9_007_199_254_740_993n;
      const size = 2 * MIB + 31;
      const source = Uint8Array.from({ length: size }, (_, index) => (index * 37) & 255);
      const output = new Uint8Array(size);
      const positions: bigint[] = [];
      const read = vi.spyOn(storage, "readInto").mockImplementation((_inode, offset, target) => {
        positions.push(offset);
        const start = Number(offset - base);
        const bytes = source.subarray(start, start + target.length);
        target.set(bytes);
        return bytes.length;
      });
      const write = vi.spyOn(storage, "write").mockImplementation((_inode, offset, bytes) => {
        positions.push(offset);
        output.set(bytes, Number(offset - base));
        return bytes.length;
      });
      const transfer = transferFixture(name, fixture.filesystem);
      const { memory, view } = transfer;
      const firstLength = 8193;
      const secondPointer = 16_384;
      const countPointer = name === "fd_pwrite" ? secondPointer + 70_000 : 16;
      const first = new Uint8Array(memory.buffer, 32, firstLength);
      const second = new Uint8Array(memory.buffer, secondPointer, size - firstLength);
      first.fill(0xa5);
      second.fill(0xa5);
      if (name === "fd_pwrite") {
        first.set(source.subarray(0, firstLength));
        second.set(source.subarray(firstLength));
      }
      view.setUint32(32, 32, true);
      view.setUint32(36, firstLength, true);
      view.setUint32(40, memory.buffer.byteLength, true);
      view.setUint32(44, 0, true);
      view.setUint32(48, secondPointer, true);
      view.setUint32(52, second.length, true);
      const original = new Uint8Array(size);
      original.set(first);
      original.set(second, first.length);
      const table = new Uint8Array(memory.buffer, 32, 24).slice();
      try {
        expect(await transfer.run(fd, 32, 3, base, countPointer)).toBe(0);
        expect(view.getUint32(countPointer, true)).toBe(size);
        expect(descriptor.offset).toBe(0n);
        expect(transfer.requests.length).toBeGreaterThan(2);
        expect(transfer.requests[0]?.transferOffset).toBe(0);
        expect(transfer.requests[1]?.transferOffset).toBe(KERNEL_SYSCALL_MAX_IO_BYTES);
        for (const request of transfer.requests) {
          expect(request.args).toEqual([fd, 32, 3, base, countPointer]);
          const region = request.regions.find(
            (entry) => entry.pointer <= 32 && entry.pointer + entry.bytes.length >= 56,
          );
          expect(region?.bytes.subarray(32 - region.pointer, 56 - region.pointer)).toEqual(table);
        }
        expect(positions[0]).toBe(base);
        expect(positions).toContain(base + BigInt(KERNEL_SYSCALL_MAX_IO_BYTES));
        if (name === "fd_pwrite") expect(output).toEqual(original);
        else {
          expect(first).toEqual(source.subarray(0, firstLength));
          expect(second).toEqual(source.subarray(firstLength));
        }
        expect(new Uint8Array(memory.buffer)[secondPointer + second.length]).toBe(0);
      } finally {
        read.mockRestore();
        write.mockRestore();
        transfer.close();
        fixture.close();
      }
    },
  );

  it.each(["fd_read", "fd_write"] as const)("returns one nonblocking %s chunk", async (name) => {
    let calls = 0;
    const filesystem = new KernelFileSystem({
      mounts: [],
      stdio: [
        {
          readInto(target) {
            calls++;
            target.fill(0x80);
            return target.length;
          },
        },
        {
          write(source) {
            calls++;
            return Math.min(source.length, 8193);
          },
        },
        {},
      ],
    });
    const fd = name === "fd_read" ? 0 : 1;
    filesystem.descriptors.get(fd).flags = 4;
    const transfer = transferFixture(name, filesystem);
    transfer.view.setUint32(32, 1024, true);
    try {
      expect(await transfer.run(fd, 32, 1, 16)).toBe(0);
      transfer.requests.length = 0;
      transfer.view.setUint32(36, MIB, true);
      new Uint8Array(transfer.memory.buffer, 1024, MIB).fill(0xa5);
      expect(await transfer.run(fd, 32, 1, 16)).toBe(0);
      expect(transfer.requests).toHaveLength(1);
      expect(calls).toBe(1);
      const count = name === "fd_read" ? 65_536 : 8193;
      expect(transfer.view.getUint32(16, true)).toBe(count);
      const bytes = new Uint8Array(transfer.memory.buffer, 1024, MIB);
      expect(
        bytes.subarray(0, count).every((byte) => byte === (name === "fd_read" ? 0x80 : 0xa5)),
      ).toBe(true);
      expect(bytes.subarray(count).every((byte) => byte === 0xa5)).toBe(true);
    } finally {
      transfer.close();
      filesystem.dispose();
    }
  });

  it("ends a zero-progress write and keeps a PIPE_BUF write in one RPC", async () => {
    let zero = false;
    const filesystem = new KernelFileSystem({
      mounts: [],
      stdio: [{}, { write: (source) => (zero ? 0 : source.length) }, {}],
    });
    const transfer = transferFixture("fd_write", filesystem);
    transfer.view.setUint32(32, 1024, true);
    transfer.view.setUint32(36, 4096, true);
    try {
      expect(await transfer.run(1, 32, 1, 16)).toBe(0);
      expect(transfer.requests).toHaveLength(1);
      expect(transfer.view.getUint32(16, true)).toBe(4096);
      zero = true;
      transfer.requests.length = 0;
      expect(await transfer.run(1, 32, 1, 16)).toBe(0);
      expect(transfer.requests).toHaveLength(1);
      expect(transfer.view.getUint32(16, true)).toBe(0);
    } finally {
      transfer.close();
      filesystem.dispose();
    }
  });

  it("preserves a read buffer aliased with its input iovec table", async () => {
    const filesystem = new KernelFileSystem({
      mounts: [],
      stdio: [
        {
          readInto(target) {
            target.fill(0x7f, 0, 3);
            return 3;
          },
        },
        {},
        {},
      ],
    });
    const host = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const module = wasmImportReactor(
      "wasi_snapshot_preview1",
      "fd_read",
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
    const view = new DataView(memory.buffer);
    const destination = new Uint8Array(memory.buffer, 32, 64);
    destination.fill(0xa5);
    view.setUint32(32, 32, true);
    view.setUint32(36, 64, true);
    const expected = destination.slice();
    expected.fill(0x7f, 0, 3);
    try {
      expect(await child.run(instance.exports.run!, 0, 32, 1, 16)).toBe(0);
      expect(view.getUint32(16, true)).toBe(3);
      expect(destination).toEqual(expected);
    } finally {
      host.close();
      filesystem.dispose();
    }
  });
});

function transferFixture(name: string, filesystem: KernelFileSystem) {
  const positioned = name === "fd_pread" || name === "fd_pwrite";
  const module = wasmImportReactor(
    "wasi_snapshot_preview1",
    name,
    positioned ? ["i32", "i32", "i32", "i64", "i32"] : ["i32", "i32", "i32", "i32"],
    ["i32"],
  );
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const requests: KernelSyscallRequest[] = [];
  const child = createChildWasi({
    module,
    args: [],
    env: {},
    syscalls: {
      async call(request) {
        requests.push(request);
        return structuredClone(await host.call(structuredClone(request)));
      },
    },
  });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  const memory = instance.exports.memory as WebAssembly.Memory;
  memory.grow(40);
  return {
    memory,
    view: new DataView(memory.buffer),
    requests,
    run: (...args: (number | bigint)[]) => child.run(instance.exports.run!, ...args),
    close: () => host.close(),
  };
}
