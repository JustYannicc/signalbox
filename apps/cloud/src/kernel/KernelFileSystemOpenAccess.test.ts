import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import {
  KernelFileSystem,
  KernelOpenFlags,
  type KernelPosixCredentials,
} from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const user = { uid: 0, gid: 0, euid: 1000, egid: 1000, groups: [42] };
const bytes = Uint8Array.of(1, 2, 3);

function fixture(credentials: KernelPosixCredentials = user) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 0, gid: 0 });
  const owner = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 0, gid: 0, euid: 0, egid: 0 }, umask: 0 },
  });
  for (const [path, mode] of [
    ["/private", 0o600],
    ["/group", 0o640],
    ["/readonly", 0o444],
    ["/secret", 0],
  ] as const) {
    const fd = owner.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, mode);
    owner.write(fd, bytes, 0n);
    owner.close(fd);
  }
  owner.chown("/group", 0, 42);
  owner.mkdir("/locked", 0o700);
  const locked = owner.open(
    "/locked/public",
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
    0o644,
  );
  owner.close(locked);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials, umask: 0 },
  });
  return {
    filesystem,
    owner,
    close() {
      filesystem.dispose();
      owner.dispose();
      database.close();
    },
  };
}

describe("final inode access at open", () => {
  it("uses effective IDs and supplementary groups on sync and async opens", async () => {
    const test = fixture();
    try {
      expect(() => test.filesystem.open("/private", KernelOpenFlags.O_RDONLY)).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      await expect(
        test.filesystem.openAsync("/private", KernelOpenFlags.O_RDONLY),
      ).rejects.toMatchObject({ code: "EACCES" });
      const allowed = await test.filesystem.openAsync("/group", KernelOpenFlags.O_RDONLY);
      const read = new Uint8Array(3);
      expect(await test.filesystem.readAsync(allowed, read, null)).toBe(3);
      expect(read).toEqual(bytes);
      test.filesystem.close(allowed);
    } finally {
      test.close();
    }
    const root = fixture({ uid: 1000, gid: 1000, euid: 0, egid: 0 });
    try {
      const fd = root.filesystem.open("/secret", KernelOpenFlags.O_RDONLY);
      root.filesystem.close(fd);
    } finally {
      root.close();
    }
  });

  it("denies truncation before changing bytes while existing descriptors retain access", () => {
    const test = fixture();
    try {
      expect(() =>
        test.filesystem.open("/readonly", KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC),
      ).toThrow(expect.objectContaining({ code: "EACCES" }));
      const fd = test.filesystem.open("/readonly", KernelOpenFlags.O_RDONLY);
      test.owner.chmod("/readonly", 0);
      const read = new Uint8Array(3);
      expect(test.filesystem.read(fd, read, null)).toBe(3);
      expect(read).toEqual(bytes);
      test.filesystem.close(fd);
      const path = test.filesystem.open("/readonly", KernelOpenFlags.O_PATH);
      expect(test.filesystem.fstat(path).size).toBe(3n);
      expect(() => test.filesystem.read(path, read, null)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      test.filesystem.close(path);
    } finally {
      test.close();
    }
  });

  it("denies traversal of a private parent on sync, async and WASI opens", async () => {
    const test = fixture();
    const syscalls = createKernelSyscallHost({
      filesystem: test.filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const results: unknown[] = [];
    try {
      try {
        const fd = test.filesystem.open("/locked/public", KernelOpenFlags.O_RDONLY);
        test.filesystem.close(fd);
        results.push("allowed");
      } catch (error) {
        results.push(error instanceof Error && "code" in error ? error.code : error);
      }
      try {
        const fd = await test.filesystem.openAsync("/locked/public", KernelOpenFlags.O_RDONLY);
        test.filesystem.close(fd);
        results.push("allowed");
      } catch (error) {
        results.push(error instanceof Error && "code" in error ? error.code : error);
      }
      const path = new TextEncoder().encode("locked/public");
      const result = await syscalls.call({
        name: "path_open",
        args: [3, 1, 128, path.byteLength, 0, 2n, 0n, 0, 256],
        memorySize: 1024,
        regions: [
          { pointer: 128, bytes: path, direction: "in" },
          { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 4 },
        ],
      });
      if (result.kind !== "return") throw new Error("Expected an open result");
      if (result.value === 0) {
        const bytes = result.regions.find((region) => region.pointer === 256)!.bytes;
        test.filesystem.close(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
      }
      results.push(result.value);
      expect(results).toEqual(["EACCES", "EACCES", 2]);
    } finally {
      syscalls.close();
      test.close();
    }
  });

  it("permits creating a mode-zero file but denies reopening it", async () => {
    const test = fixture();
    try {
      const fd = await test.filesystem.openAsync(
        "/new",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
        0,
      );
      expect(test.filesystem.write(fd, bytes, 0n)).toBe(3);
      test.filesystem.close(fd);
      await expect(
        test.filesystem.openAsync("/new", KernelOpenFlags.O_RDONLY),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      test.close();
    }
  });
});
