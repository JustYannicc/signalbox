import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import type { KernelFileByteAccess, KernelFileByteView } from "./KernelFileBytes.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { AsyncWASI, type AsyncStorage, type Storage } from "./Wasi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();

type WasmValueType = "i32" | "i64";
interface WasiImportSpec {
  readonly name: string;
  readonly params: readonly WasmValueType[];
}

function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
}

function wasmName(value: string): number[] {
  const bytes = [...encoder.encode(value)];
  return [...leb(bytes.length), ...bytes];
}

function wasmSection(id: number, content: number[]): number[] {
  return [id, ...leb(content.length), ...content];
}

function wasmWasiImports(imports: readonly WasiImportSpec[]): WebAssembly.Module {
  const valueType = (type: WasmValueType) => (type === "i32" ? 0x7f : 0x7e);
  const types = imports.flatMap((item) => [
    0x60,
    ...leb(item.params.length),
    ...item.params.map(valueType),
    1,
    0x7f,
  ]);
  const importEntries = imports.flatMap((item, index) => [
    ...wasmName("wasi_snapshot_preview1"),
    ...wasmName(item.name),
    0,
    ...leb(index),
  ]);
  const exported = [
    ...wasmName("memory"),
    2,
    0,
    ...imports.flatMap((item, index) => [...wasmName(item.name), 0, ...leb(index)]),
  ];

  return new WebAssembly.Module(
    Uint8Array.from([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...wasmSection(1, [imports.length, ...types]),
      ...wasmSection(2, [imports.length, ...importEntries]),
      ...wasmSection(5, [1, 0, 1]),
      ...wasmSection(7, [imports.length + 1, ...exported]),
    ]),
  );
}

function exportedFunction(instance: WebAssembly.Instance, name: string) {
  const fn = instance.exports[name];
  if (typeof fn !== "function") throw new Error(`Missing WASI import export ${name}`);
  return fn as (...args: Array<number | bigint>) => unknown;
}

describe("KernelFileByteAccess storage lifetime", () => {
  it("releases the backing inode pin even when final view release fails", () => {
    const fixture = sqliteFixture();
    const baseStorage = createFacetSqliteStorage(fixture.storage, now);
    let releases = 0;
    const storage: Storage = {
      ...baseStorage,
      release(inode) {
        releases++;
        baseStorage.release(inode);
      },
    };
    const inode = storage.create(storage.root, "file", { type: "file", exclusive: true });
    storage.release(inode);
    releases = 0;
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    let accessReleases = 0;
    const releaseError = new Error("view cleanup failed");
    const view: KernelFileByteView = {
      completion: "sync",
      storage,
      bind(boundInode) {
        const byteAccess: KernelFileByteAccess = {
          stat: () => storage.stat(boundInode),
          readInto: (offset, target) => storage.readInto(boundInode, offset, target),
          write: (offset, source) => storage.write(boundInode, offset, source),
          append: (source) => storage.append(boundInode, source),
          truncate: (size) => storage.truncate(boundInode, size),
          sync: (dataOnly) => storage.sync(boundInode, dataOnly),
          release() {
            accessReleases++;
            throw releaseError;
          },
        };
        return byteAccess;
      },
    };

    try {
      filesystem.setFileBytes({ kind: "view", view });
      const fd = filesystem.open("/file", KernelOpenFlags.O_RDONLY);
      filesystem.unlink("/file");
      expect(() => filesystem.close(fd)).toThrow(releaseError);
      expect(accessReleases).toBe(1);
      expect(releases).toBe(1);
      expect(() => storage.stat(inode)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      filesystem.dispose();
      fixture.close();
    }
  });

  it("keeps canonical AsyncStorage syscalls on their awaited backing path", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const inode = storage.create(storage.root, "file", { type: "file", exclusive: true });
    storage.write(inode, 0n, encoder.encode("abc"));
    storage.release(inode);
    const asyncStorage = asAsyncStorage(storage);
    const wasi = new AsyncWASI({
      version: "preview1",
      mounts: [{ path: "/", storage: asyncStorage }],
    });
    const imports = [
      { name: "path_filestat_get", params: ["i32", "i32", "i32", "i32", "i32"] },
      {
        name: "path_open",
        params: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
      },
      { name: "fd_read", params: ["i32", "i32", "i32", "i32"] },
      { name: "fd_write", params: ["i32", "i32", "i32", "i32"] },
      { name: "fd_close", params: ["i32"] },
    ] satisfies readonly WasiImportSpec[];
    const instance = new WebAssembly.Instance(wasmWasiImports(imports), wasi.getImportObject());

    try {
      await wasi.initialize(instance);
      const memory = instance.exports.memory as WebAssembly.Memory;
      const memoryView = new DataView(memory.buffer);
      const memoryBytes = new Uint8Array(memory.buffer);
      memoryBytes.set(encoder.encode("file"), 16);
      expect(
        await wasi.run(exportedFunction(instance, "path_filestat_get"), 3, 0, 16, 4, 1024),
      ).toBe(0);
      expect(memoryView.getBigUint64(1024 + 32, true)).toBe(3n);

      expect(
        await wasi.run(
          exportedFunction(instance, "path_open"),
          3,
          0,
          16,
          4,
          0,
          (1n << 28n) - 1n,
          0n,
          0,
          32,
        ),
      ).toBe(0);
      const fd = memoryView.getUint32(32, true);
      memoryView.setUint32(256, 4096, true);
      memoryView.setUint32(260, 3, true);
      expect(await wasi.run(exportedFunction(instance, "fd_read"), fd, 256, 1, 300)).toBe(0);
      expect(memoryView.getUint32(300, true)).toBe(3);
      expect(new Uint8Array(memory.buffer, 4096, 3)).toEqual(encoder.encode("abc"));

      memoryBytes.set(encoder.encode("!"), 8192);
      memoryView.setUint32(256, 8192, true);
      memoryView.setUint32(260, 1, true);
      expect(await wasi.run(exportedFunction(instance, "fd_write"), fd, 256, 1, 304)).toBe(0);
      expect(memoryView.getUint32(304, true)).toBe(1);
      expect(storage.stat(inode).size).toBe(4n);
      expect(await wasi.run(exportedFunction(instance, "fd_close"), fd)).toBe(0);
    } finally {
      await wasi.close();
      fixture.close();
    }
  });
});

function asAsyncStorage(storage: Storage): AsyncStorage {
  return {
    root: storage.root,
    lookup: async (...args) => storage.lookup(...args),
    stat: async (...args) => storage.stat(...args),
    readlink: async (...args) => storage.readlink(...args),
    readdir: async (...args) => storage.readdir(...args),
    retain: async (...args) => storage.retain(...args),
    release: async (...args) => storage.release(...args),
    readInto: async (...args) => storage.readInto(...args),
    write: async (...args) => storage.write(...args),
    append: async (...args) => storage.append(...args),
    truncate: async (...args) => storage.truncate(...args),
    setTimes: async (...args) => storage.setTimes(...args),
    sync: async (...args) => storage.sync(...args),
    create: async (...args) => storage.create(...args),
    link: async (...args) => storage.link(...args),
    unlink: async (...args) => storage.unlink(...args),
    rename: async (...args) => storage.rename(...args),
  };
}
