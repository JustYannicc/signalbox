import { describe, expect, it } from "vite-plus/test";
import {
  bindFileByteAccess,
  canonicalFileByteSelection,
  type KernelFileByteSelection,
  type KernelFileByteView,
} from "./KernelFileBytes.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import type { Storage } from "./storage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { WasiFileSystem } from "./wasi/internal_wasi_fs.ts";
import { runSync } from "./wasi/internal_wasi_calls.ts";
import {
  ALL_RIGHTS,
  READ_ONLY_RIGHTS,
  WasiDescriptorTable,
} from "./wasi/internal_wasi_descriptors.ts";
import { WasiMemory } from "./wasi/internal_wasi_memory.ts";
import type { WasiMountedStorage } from "./wasi/internal_wasi_paths.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const O_TRUNCATE = 8;
const APPEND = 1;

describe("KernelFileByteSelection", () => {
  it("rejects a view bound to another storage before calling bind", () => {
    const fixture = sqliteFixture();
    const otherFixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const otherStorage = createFacetSqliteStorage(otherFixture.storage, now);
    let binds = 0;
    const view: KernelFileByteView = {
      completion: "sync",
      storage,
      bind() {
        binds++;
        throw new Error("must not bind");
      },
    };

    try {
      expect(bindFileByteAccess(canonicalFileByteSelection, storage, storage.root)).toBeUndefined();
      expect(() => bindFileByteAccess({ kind: "view", view }, otherStorage, storage.root)).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(binds).toBe(0);
    } finally {
      fixture.close();
      otherFixture.close();
    }
  });

  it("routes path and fd byte operations through one shared open description", () => {
    const fixture = sqliteFixture();
    const baseStorage = createFacetSqliteStorage(fixture.storage, now);
    let storageReleases = 0;
    const storage: Storage = {
      ...baseStorage,
      release(inode) {
        storageReleases++;
        baseStorage.release(inode);
      },
    };
    const inode = storage.create(storage.root, "file", { type: "file", exclusive: true });
    storage.write(inode, 0n, encoder.encode("canonical"));
    storage.release(inode);
    const directoryInode = storage.create(storage.root, "directory", {
      type: "directory",
      exclusive: true,
    });
    storage.release(directoryInode);
    storageReleases = 0;

    const rawByInode = new Map<bigint, Uint8Array>();
    const calls = {
      binds: 0,
      releases: 0,
      writes: [] as { offset: bigint; length: number }[],
      appends: [] as { offset: bigint; length: number }[],
      truncates: [] as bigint[],
      syncs: [] as boolean[],
    };
    const view: KernelFileByteView = {
      completion: "sync",
      storage,
      bind(boundInode) {
        calls.binds++;
        if (!rawByInode.has(boundInode)) rawByInode.set(boundInode, encoder.encode("view"));
        const current = () => rawByInode.get(boundInode) ?? new Uint8Array();
        const replace = (offset: number, source: Uint8Array) => {
          const previous = current();
          const end = offset + source.byteLength;
          const next = new Uint8Array(Math.max(previous.byteLength, end));
          next.set(previous);
          next.set(source, offset);
          rawByInode.set(boundInode, next);
        };
        return {
          stat: () => ({ ...storage.stat(boundInode), size: BigInt(current().byteLength) }),
          readInto(offset, target) {
            const source = current();
            const start = Number(offset);
            const count = Math.max(0, Math.min(target.byteLength, source.byteLength - start));
            target.set(source.subarray(start, start + count));
            return count;
          },
          write(offset, source) {
            calls.writes.push({ offset, length: source.byteLength });
            replace(Number(offset), source);
            return source.byteLength;
          },
          append(source) {
            const offset = BigInt(current().byteLength);
            calls.appends.push({ offset, length: source.byteLength });
            replace(Number(offset), source);
            return { offset, bytesWritten: source.byteLength };
          },
          truncate(size) {
            calls.truncates.push(size);
            const next = new Uint8Array(Number(size));
            next.set(current().subarray(0, next.byteLength));
            rawByInode.set(boundInode, next);
          },
          sync(dataOnly) {
            calls.syncs.push(dataOnly);
          },
          release() {
            calls.releases++;
          },
        };
      },
    };

    const memory = new WasiMemory();
    memory.set(new WebAssembly.Memory({ initial: 2 }));
    const table = new WasiDescriptorTable();
    const mount: WasiMountedStorage = {
      id: 0,
      path: "/",
      storage,
      root: storage.root,
      readOnly: false,
      device: 1n,
    };
    storage.retain(storage.root);
    const rootFd = table.allocate({
      kind: "directory",
      mount,
      inode: storage.root,
      capabilityRoot: storage.root,
      ancestors: [storage.root],
      pathComponents: [],
      preopenPath: "/",
      preopen: true,
      offset: 0n,
      rightsBase: ALL_RIGHTS,
      rightsInheriting: ALL_RIGHTS,
      flags: 0,
    });

    let selection: KernelFileByteSelection = { kind: "view", view };
    let selectionReads = 0;
    const wasi = new WasiFileSystem(memory, [], [], {
      table,
      ownership: "borrowed",
      fileBytes: () => {
        selectionReads++;
        return selection;
      },
    });
    memory.range(16, 4).set(encoder.encode("file"));

    const pathStatSize = () => {
      runSync(wasi.imports.path_filestat_get(rootFd, 0, 16, 4, 1024));
      return memory.view(1024, 64).getBigUint64(32, true);
    };
    const open = (oflags = 0, fdflags = 0, rightsBase = ALL_RIGHTS, path = "file") => {
      const pathBytes = encoder.encode(path);
      memory.range(16, pathBytes.byteLength).set(pathBytes);
      runSync(
        wasi.imports.path_open(
          rootFd,
          0,
          16,
          pathBytes.byteLength,
          oflags,
          rightsBase,
          0n,
          fdflags,
          32,
        ),
      );
      return memory.readU32(32);
    };

    try {
      expect(pathStatSize()).toBe(4n);
      expect(calls.binds).toBe(1);
      expect(calls.releases).toBe(1);

      selection = canonicalFileByteSelection;
      expect(pathStatSize()).toBe(9n);
      expect(calls.binds).toBe(1);

      selection = { kind: "view", view };
      const beforeRejectedOpens = { binds: calls.binds, selections: selectionReads };
      expect(() => open(0, 0, 1n << 60n)).toThrow(expect.objectContaining({ errno: 76 }));
      expect(calls.binds).toBe(beforeRejectedOpens.binds);
      expect(selectionReads).toBe(beforeRejectedOpens.selections);

      Object.assign(mount, { readOnly: true });
      expect(() => open(O_TRUNCATE, 0, READ_ONLY_RIGHTS)).toThrow(
        expect.objectContaining({ errno: 69 }),
      );
      Object.assign(mount, { readOnly: false });
      expect(calls.binds).toBe(beforeRejectedOpens.binds);
      expect(selectionReads).toBe(beforeRejectedOpens.selections);

      expect(() => open(O_TRUNCATE, 0, ALL_RIGHTS, "directory")).toThrow(
        expect.objectContaining({ errno: 31 }),
      );
      expect(calls.binds).toBe(beforeRejectedOpens.binds);
      expect(selectionReads).toBe(beforeRejectedOpens.selections);

      const releasesBeforeOpenedFiles = storageReleases;
      const fd = open();
      expect(selectionReads).toBe(3);
      expect(table.get(fd).byteView).toBe(view);
      expect(calls.binds).toBe(2);

      runSync(wasi.imports.fd_seek(fd, 0n, 2, 600));
      expect(memory.view(600, 8).getBigUint64(0, true)).toBe(4n);
      runSync(wasi.imports.fd_seek(fd, 0n, 0, 600));
      memory.view(256, 8).setUint32(0, 4096, true);
      memory.view(256, 8).setUint32(4, 4, true);
      runSync(wasi.imports.fd_read(fd, 256, 1, 300));
      expect(memory.readU32(300)).toBe(4);
      expect(decoder.decode(memory.range(4096, 4))).toBe("view");

      const largeWrite = new Uint8Array(70_000).fill(0x7a);
      memory.range(8192, largeWrite.byteLength).set(largeWrite);
      memory.view(256, 8).setUint32(0, 8192, true);
      memory.view(256, 8).setUint32(4, largeWrite.byteLength, true);
      runSync(wasi.imports.fd_pwrite(fd, 256, 1, 1n, 304));
      expect(memory.readU32(304)).toBe(largeWrite.byteLength);
      expect(calls.writes).toEqual([{ offset: 1n, length: largeWrite.byteLength }]);
      expect(table.get(fd).offset).toBe(4n);

      runSync(wasi.imports.fd_filestat_get(fd, 1024));
      expect(memory.view(1024, 64).getBigUint64(32, true)).toBe(70_001n);
      runSync(wasi.imports.fd_sync(fd));
      runSync(wasi.imports.fd_datasync(fd));
      expect(calls.syncs).toEqual([false, true]);

      const alias = table.duplicate(fd);
      runSync(wasi.imports.fd_close(fd));
      expect(calls.releases).toBe(1);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles);
      runSync(wasi.imports.fd_close(alias));
      expect(calls.releases).toBe(2);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles + 1);

      const appendFd = open(0, APPEND);
      memory.range(8192, 4).set(encoder.encode("tail"));
      memory.view(256, 8).setUint32(0, 8192, true);
      memory.view(256, 8).setUint32(4, 4, true);
      runSync(wasi.imports.fd_write(appendFd, 256, 1, 304));
      expect(calls.appends).toEqual([{ offset: 70_001n, length: 4 }]);
      expect(table.get(appendFd).offset).toBe(70_005n);
      runSync(wasi.imports.fd_close(appendFd));
      expect(calls.releases).toBe(3);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles + 2);

      const truncatedFd = open(O_TRUNCATE);
      expect(calls.truncates).toEqual([0n]);
      runSync(wasi.imports.fd_close(truncatedFd));
      expect(calls.releases).toBe(4);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles + 3);
      expect(storage.stat(inode).size).toBe(9n);
    } finally {
      runSync(table.closeAll());
      fixture.close();
    }
  });
});
