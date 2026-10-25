import { describe, expect, it } from "vite-plus/test";
import {
  bindFileByteAccess,
  canonicalFileByteSelection,
  type KernelFileByteSelection,
  type KernelFileByteView,
} from "./KernelFileBytes.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import type { KernelSyscallResponse } from "./KernelSyscallPort.ts";
import type { Storage } from "./Wasi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALL_WASI_RIGHTS = (1n << 28n) - 1n;
const O_TRUNCATE = 8;
const APPEND = 1;

function bytesAt(response: KernelSyscallResponse, pointer: number, length: number): Uint8Array {
  if (response.kind !== "return") throw new Error("Expected a syscall return value");
  const region = response.regions.find(
    (candidate) =>
      pointer >= candidate.pointer &&
      pointer + length <= candidate.pointer + candidate.bytes.length,
  );
  if (!region) throw new Error(`No returned syscall memory at ${pointer}`);
  const offset = pointer - region.pointer;
  return region.bytes.subarray(offset, offset + length);
}

function u32At(response: KernelSyscallResponse, pointer: number): number {
  const bytes = bytesAt(response, pointer, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

function u64At(response: KernelSyscallResponse, pointer: number): bigint {
  const bytes = bytesAt(response, pointer, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

async function pathStat(host: ReturnType<typeof createKernelSyscallHost>, path: string) {
  const pathBytes = encoder.encode(path);
  return host.call({
    name: "path_filestat_get",
    args: [3, 0, 16, pathBytes.byteLength, 1024],
    memorySize: 4096,
    regions: [
      { pointer: 16, bytes: pathBytes },
      { pointer: 1024, bytes: new Uint8Array(64) },
    ],
  });
}

async function pathOpen(
  host: ReturnType<typeof createKernelSyscallHost>,
  path: string,
  oflags = 0,
  fdflags = 0,
  rightsBase = ALL_WASI_RIGHTS,
) {
  const pathBytes = encoder.encode(path);
  return host.call({
    name: "path_open",
    args: [3, 0, 16, pathBytes.byteLength, oflags, rightsBase, 0n, fdflags, 32],
    memorySize: 4096,
    regions: [
      { pointer: 16, bytes: pathBytes },
      { pointer: 32, bytes: new Uint8Array(4) },
    ],
  });
}

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

  it("routes path and fd byte operations through one shared open description", async () => {
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

    const selection: KernelFileByteSelection = { kind: "view", view };
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      fileBytes: selection,
    });
    const host = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const readOnlyFilesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      fileBytes: selection,
    });
    const readOnlyHost = createKernelSyscallHost({
      filesystem: readOnlyFilesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const readOnlyPreopen = readOnlyFilesystem.descriptors.get(3);
    expect(readOnlyPreopen.rightsBase & (1n << 19n)).toBe(1n << 19n);
    const readOnlyMount = readOnlyPreopen.mount;
    if (!readOnlyMount) throw new Error("Missing root mount");
    // Preserve preopen rights so path_open reaches the mount's EROFS check.
    Object.assign(readOnlyMount, { readOnly: true });

    try {
      const initialStat = await pathStat(host, "file");
      expect(initialStat).toMatchObject({ kind: "return", value: 0 });
      expect(u64At(initialStat, 1024 + 32)).toBe(4n);
      expect(calls.binds).toBe(1);
      expect(calls.releases).toBe(1);

      filesystem.setFileBytes(canonicalFileByteSelection);
      const canonicalStat = await pathStat(host, "file");
      expect(canonicalStat).toMatchObject({ kind: "return", value: 0 });
      expect(u64At(canonicalStat, 1024 + 32)).toBe(9n);
      expect(calls.binds).toBe(1);

      filesystem.setFileBytes(selection);
      const beforeRejectedOpens = calls.binds;
      const rejectedRights = await pathOpen(host, "file", 0, 0, 1n << 60n);
      expect(rejectedRights).toMatchObject({ kind: "return", value: 76 });
      expect(calls.binds).toBe(beforeRejectedOpens);

      const rejectedReadOnly = await pathOpen(readOnlyHost, "file", O_TRUNCATE, 0, 2n);
      expect(rejectedReadOnly).toMatchObject({ kind: "return", value: 69 });
      const rejectedDirectory = await pathOpen(host, "directory", O_TRUNCATE);
      expect(rejectedDirectory).toMatchObject({ kind: "return", value: 31 });
      expect(calls.binds).toBe(beforeRejectedOpens);

      const opened = await pathOpen(host, "file");
      expect(opened).toMatchObject({ kind: "return", value: 0 });
      const fd = u32At(opened, 32);
      expect(filesystem.descriptors.get(fd).byteView).toBe(view);
      expect(calls.binds).toBe(2);

      const seekEnd = await host.call({
        name: "fd_seek",
        args: [fd, 0n, 2, 600],
        memorySize: 608,
        regions: [{ pointer: 600, bytes: new Uint8Array(8) }],
      });
      expect(seekEnd).toMatchObject({ kind: "return", value: 0 });
      expect(u64At(seekEnd, 600)).toBe(4n);
      const seekStart = await host.call({
        name: "fd_seek",
        args: [fd, 0n, 0, 600],
        memorySize: 608,
        regions: [{ pointer: 600, bytes: new Uint8Array(8) }],
      });
      expect(seekStart).toMatchObject({ kind: "return", value: 0 });

      const read = await host.call({
        name: "fd_read",
        args: [fd, 256, 1, 300],
        memorySize: 4100,
        regions: [
          { pointer: 256, bytes: Uint8Array.from([0, 16, 0, 0, 4, 0, 0, 0]) },
          { pointer: 300, bytes: new Uint8Array(4) },
          { pointer: 4096, bytes: new Uint8Array(4) },
        ],
      });
      expect(read).toMatchObject({ kind: "return", value: 0 });
      expect(u32At(read, 300)).toBe(4);
      expect(decoder.decode(bytesAt(read, 4096, 4))).toBe("view");

      const alias = filesystem.descriptors.duplicate(fd);
      const largeWrite = new Uint8Array(70_000).fill(0x7a);
      const pwrite = await host.call({
        name: "fd_pwrite",
        args: [fd, 256, 1, 1n, 304],
        memorySize: 81_920,
        regions: [
          { pointer: 256, bytes: Uint8Array.from([0, 32, 0, 0, 0x70, 0x11, 1, 0]) },
          { pointer: 304, bytes: new Uint8Array(4) },
          { pointer: 8192, bytes: largeWrite },
        ],
      });
      expect(pwrite).toMatchObject({ kind: "return", value: 0 });
      expect(u32At(pwrite, 304)).toBe(largeWrite.byteLength);
      expect(calls.writes).toEqual([{ offset: 1n, length: largeWrite.byteLength }]);
      expect(filesystem.descriptors.get(fd).offset).toBe(4n);
      expect(filesystem.descriptors.get(alias).offset).toBe(4n);

      const fileStat = await host.call({
        name: "fd_filestat_get",
        args: [fd, 1024],
        memorySize: 1088,
        regions: [{ pointer: 1024, bytes: new Uint8Array(64) }],
      });
      expect(fileStat).toMatchObject({ kind: "return", value: 0 });
      expect(u64At(fileStat, 1024 + 32)).toBe(70_001n);

      filesystem.setFileBytes(canonicalFileByteSelection);
      await expect(filesystem.statAsync(`/proc/self/fd/${fd}`)).resolves.toMatchObject({
        size: 70_001n,
        ino: inode,
      });
      await expect(filesystem.statAsync(`/dev/fd/${alias}`)).resolves.toMatchObject({
        size: 70_001n,
        ino: inode,
      });
      expect(storage.stat(inode).size).toBe(9n);
      expect(calls.binds).toBe(2);
      expect(calls.releases).toBe(1);
      filesystem.setFileBytes(selection);

      const sync = await host.call({ name: "fd_sync", args: [fd], memorySize: 0, regions: [] });
      const datasync = await host.call({
        name: "fd_datasync",
        args: [fd],
        memorySize: 0,
        regions: [],
      });
      expect(sync).toMatchObject({ kind: "return", value: 0 });
      expect(datasync).toMatchObject({ kind: "return", value: 0 });
      expect(calls.syncs).toEqual([false, true]);

      const releasesBeforeOpenedFiles = storageReleases;
      const closeOriginal = await host.call({
        name: "fd_close",
        args: [fd],
        memorySize: 0,
        regions: [],
      });
      expect(closeOriginal).toMatchObject({ kind: "return", value: 0 });
      expect(calls.releases).toBe(1);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles);
      const closeAlias = await host.call({
        name: "fd_close",
        args: [alias],
        memorySize: 0,
        regions: [],
      });
      expect(closeAlias).toMatchObject({ kind: "return", value: 0 });
      expect(calls.releases).toBe(2);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles + 1);

      const appendOpened = await pathOpen(host, "file", 0, APPEND);
      expect(appendOpened).toMatchObject({ kind: "return", value: 0 });
      const appendFd = u32At(appendOpened, 32);
      const append = await host.call({
        name: "fd_write",
        args: [appendFd, 256, 1, 304],
        memorySize: 8200,
        regions: [
          { pointer: 256, bytes: Uint8Array.from([0, 32, 0, 0, 4, 0, 0, 0]) },
          { pointer: 304, bytes: new Uint8Array(4) },
          { pointer: 8192, bytes: encoder.encode("tail") },
        ],
      });
      expect(append).toMatchObject({ kind: "return", value: 0 });
      expect(u32At(append, 304)).toBe(4);
      expect(calls.appends).toEqual([{ offset: 70_001n, length: 4 }]);
      expect(filesystem.descriptors.get(appendFd).offset).toBe(70_005n);
      const closeAppend = await host.call({
        name: "fd_close",
        args: [appendFd],
        memorySize: 0,
        regions: [],
      });
      expect(closeAppend).toMatchObject({ kind: "return", value: 0 });
      expect(calls.releases).toBe(3);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles + 2);

      const truncated = await pathOpen(host, "file", O_TRUNCATE);
      expect(truncated).toMatchObject({ kind: "return", value: 0 });
      const truncatedFd = u32At(truncated, 32);
      expect(calls.truncates).toEqual([0n]);
      const closeTruncated = await host.call({
        name: "fd_close",
        args: [truncatedFd],
        memorySize: 0,
        regions: [],
      });
      expect(closeTruncated).toMatchObject({ kind: "return", value: 0 });
      expect(calls.releases).toBe(4);
      expect(storageReleases).toBe(releasesBeforeOpenedFiles + 3);
      expect(storage.stat(inode).size).toBe(9n);
    } finally {
      host.close();
      readOnlyHost.close();
      readOnlyFilesystem.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });
});
