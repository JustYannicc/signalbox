import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelCoreutilsImports } from "./KernelCoreutilsImports.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 } as const;
const now = () => 1_800_000_000_000_000_001n;

describe("KernelCoreutilsImports", () => {
  it("applies proc_umask only after validating its output pointer", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials, umask: 0o022 },
    });
    const wakes = new KernelWakeRegistry();
    const module = wasmImportReactor("host_process", "proc_umask", ["i32", "i32"], ["i32"]);
    let memory: WebAssembly.Memory | undefined;
    try {
      const imports = createKernelCoreutilsImports({
        module,
        memory: () => {
          if (memory === undefined) throw new Error("Guest memory is not bound");
          return memory;
        },
        fileSystem: filesystem,
        wakes,
        asyncMode: false,
      });
      const instance = new WebAssembly.Instance(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      const run = instance.exports.run as (mask: number, previousPointer: number) => number;
      const pointer = 64;

      expect(run(0o027, pointer)).toBe(0);
      expect(new DataView(memory.buffer).getUint32(pointer, true)).toBe(0o022);
      expect(filesystem.posixPolicy?.umask).toBe(0o027);

      expect(run(0o077, memory.buffer.byteLength - 3)).toBe(21);
      expect(filesystem.posixPolicy?.umask).toBe(0o027);
      expect(run(0o7777, pointer)).toBe(28);
      expect(filesystem.posixPolicy?.umask).toBe(0o027);
    } finally {
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });

  it("returns the POSIX policy error without changing the output or process state", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    const wakes = new KernelWakeRegistry();
    const module = wasmImportReactor("host_process", "proc_umask", ["i32", "i32"], ["i32"]);
    let memory: WebAssembly.Memory | undefined;
    try {
      const imports = createKernelCoreutilsImports({
        module,
        memory: () => {
          if (memory === undefined) throw new Error("Guest memory is not bound");
          return memory;
        },
        fileSystem: filesystem,
        wakes,
        asyncMode: false,
      });
      const instance = new WebAssembly.Instance(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      const run = instance.exports.run as (mask: number, previousPointer: number) => number;
      const pointer = 64;
      new DataView(memory.buffer).setUint32(pointer, 123, true);

      expect(run(0o027, pointer)).toBe(58);
      expect(new DataView(memory.buffer).getUint32(pointer, true)).toBe(123);
    } finally {
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });
});
