import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

const MIB = 1024 * 1024;

describe("directional child WASI transfers", () => {
  it.each(["short", "eof", "error", "partial-error"] as const)(
    "preserves untouched bytes on a %s read",
    async (mode) => {
      let calls = 0;
      const filesystem = new KernelFileSystem({
        mounts: [],
        stdio: [
          {
            readInto(target) {
              calls++;
              if (mode === "error" || (mode === "partial-error" && calls === 2))
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
      view.setUint32(16, 0xeeeeeeee, true);
      view.setUint32(32, 1024, true);
      view.setUint32(36, 128 * 1024, true);
      const destination = new Uint8Array(memory.buffer, 1024, 128 * 1024);
      destination.fill(0xa5);
      const written = mode === "short" ? 3 : mode === "partial-error" ? 65_536 : 0;
      const failed = mode === "error" || mode === "partial-error";
      try {
        expect(await child.run(instance.exports.run!, 0, 32, 1, 16)).toBe(failed ? 29 : 0);
        expect(view.getUint32(16, true)).toBe(failed ? 0xeeeeeeee : written);
        expect(destination.subarray(0, written).every((b) => b === 0)).toBe(true);
        expect(destination.subarray(written).every((b) => b === 0xa5)).toBe(true);
        expect(returned.map((r) => [r.pointer, r.bytes.length])).toEqual([
          ...(!failed ? [[16, 4]] : []),
          ...(written ? [[1024, written]] : []),
        ]);
      } finally {
        host.close();
        filesystem.dispose();
      }
    },
  );

  it.each([
    ["fd_read", MIB, MIB],
    ["fd_write", MIB, MIB],
    ["fd_read", 17 * MIB, 16 * MIB],
    ["fd_write", 17 * MIB, 16 * MIB],
    ["fd_write", MIB, 3],
  ] as const)(
    "%s with %i bytes returns %i bytes with one directional payload transfer",
    async (name, size, count) => {
      const filesystem = new KernelFileSystem({
        mounts: [],
        stdio: [
          {
            readInto: (target) => {
              target.fill(0x5a);
              return target.length;
            },
          },
          { write: (source) => Math.min(source.length, count) },
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
      const child = createChildWasi({
        module,
        args: [],
        env: {},
        syscalls: {
          async call(request) {
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
            if (response.kind === "return")
              received += response.regions.reduce((n, r) => n + r.bytes.length, 0);
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
      view.setUint32(36, size, true);
      const destination = new Uint8Array(memory.buffer, 1024, size);
      destination.fill(0xa5);
      try {
        expect(await child.run(instance.exports.run!, name === "fd_read" ? 0 : 1, 32, 1, 16)).toBe(
          0,
        );
        expect(view.getUint32(16, true)).toBe(count);
        expect(
          destination.subarray(0, count).every((b) => b === (name === "fd_read" ? 0x5a : 0xa5)),
        ).toBe(true);
        expect(destination.subarray(count).every((b) => b === 0xa5)).toBe(true);
        expect(sent).toBe(name === "fd_read" ? 8 : Math.min(size, 16 * MIB) + 8);
        expect(received).toBe(name === "fd_read" ? count + 4 : 4);
        expect(compared).toBe(0);
      } finally {
        host.close();
        filesystem.dispose();
      }
    },
  );

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
