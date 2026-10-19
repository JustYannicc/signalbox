import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import type { KernelFileByteAccess } from "./KernelFileBytes.ts";
import type { AsyncStorage, Storage } from "./storage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { ALL_RIGHTS, WasiDescriptorTable } from "./wasi/internal_wasi_descriptors.ts";
import { runAsync, runSync } from "./wasi/internal_wasi_calls.ts";
import { WasiFileSystem } from "./wasi/internal_wasi_fs.ts";
import { WasiMemory } from "./wasi/internal_wasi_memory.ts";
import type { WasiMountedStorage } from "./wasi/internal_wasi_paths.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    const mount: WasiMountedStorage = {
      id: 0,
      path: "/",
      storage,
      root: storage.root,
      readOnly: false,
      device: 1n,
    };
    const table = new WasiDescriptorTable();
    storage.retain(inode);
    let accessReleases = 0;
    const releaseError = new Error("view cleanup failed");
    const byteAccess: KernelFileByteAccess = {
      stat: () => storage.stat(inode),
      readInto: (offset, target) => storage.readInto(inode, offset, target),
      write: (offset, source) => storage.write(inode, offset, source),
      append: (source) => storage.append(inode, source),
      truncate: (size) => storage.truncate(inode, size),
      sync: (dataOnly) => storage.sync(inode, dataOnly),
      release() {
        accessReleases++;
        throw releaseError;
      },
    };
    const fd = table.allocate({
      kind: "file",
      mount,
      inode,
      offset: 0n,
      rightsBase: ALL_RIGHTS,
      rightsInheriting: 0n,
      flags: 0,
      byteAccess,
    });

    try {
      expect(() => runSync(table.close(fd))).toThrow(releaseError);
      expect(accessReleases).toBe(1);
      expect(releases).toBe(1);
    } finally {
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
    const memory = new WasiMemory();
    memory.set(new WebAssembly.Memory({ initial: 1 }));
    const wasi = new WasiFileSystem(memory, [{ path: "/", storage: asyncStorage }], []);

    try {
      await runAsync(wasi.initialize());
      memory.range(16, 4).set(encoder.encode("file"));
      await runAsync(wasi.imports.path_filestat_get(3, 0, 16, 4, 1024));
      expect(memory.view(1024, 64).getBigUint64(32, true)).toBe(3n);

      await runAsync(wasi.imports.path_open(3, 0, 16, 4, 0, ALL_RIGHTS, 0n, 0, 32));
      const fd = memory.readU32(32);
      memory.view(256, 8).setUint32(0, 4096, true);
      memory.view(256, 8).setUint32(4, 3, true);
      await runAsync(wasi.imports.fd_read(fd, 256, 1, 300));
      expect(memory.readU32(300)).toBe(3);
      expect(decoder.decode(memory.range(4096, 3))).toBe("abc");

      memory.range(8192, 1).set(encoder.encode("!"));
      memory.view(256, 8).setUint32(0, 8192, true);
      memory.view(256, 8).setUint32(4, 1, true);
      await runAsync(wasi.imports.fd_write(fd, 256, 1, 304));
      expect(memory.readU32(304)).toBe(1);
      expect(storage.stat(inode).size).toBe(4n);
      await runAsync(wasi.imports.fd_close(fd));
    } finally {
      await runAsync(wasi.close());
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
