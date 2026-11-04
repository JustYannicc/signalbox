import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import type { KernelLowerFileSystemEntry } from "./KernelLowerFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function fixture() {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const lookups: string[][] = [];
  const entries = new Map<string, KernelLowerFileSystemEntry>(
    ["/first", "/second", "/dynamic", "/second/tool", "/dynamic/tool"].map((path) => [
      path,
      {
        path,
        stat: {
          type: path.endsWith("/tool") ? "file" : "directory",
          size: 0n,
          nlink: 1n,
          atimeNs: 1n,
          mtimeNs: 1n,
          ctimeNs: 1n,
        },
        metadata: { mode: 0o755, uid: 0, gid: 0 },
      },
    ]),
  );
  const lower = filesystem.installLowerFileSystem({
    async lookup(paths) {
      lookups.push([...paths]);
      return paths.map((path) => entries.get(path));
    },
    async readdir() {
      return undefined;
    },
    async readlink() {
      throw new Error("No symlinks in this namespace");
    },
    async read() {
      throw new Error("Metadata lookup must not read bytes");
    },
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: { PATH: "/first:/second" },
    signal: new AbortController().signal,
  });
  async function stat(path: string, fd = 3) {
    const bytes = new TextEncoder().encode(path);
    const result = await host.call({
      name: "path_filestat_get",
      args: [fd, 1, 0, bytes.length, 512],
      memorySize: 1024,
      regions: [
        { pointer: 0, bytes, direction: "in" },
        { pointer: 512, bytes: new Uint8Array(), direction: "out", length: 64 },
      ],
    });
    if (result.kind !== "return") throw new Error(`Unexpected syscall result: ${result.kind}`);
    return result;
  }
  return {
    filesystem,
    lower,
    lookups,
    stat,
    close() {
      host.close();
      lower.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}

describe("Bash PATH metadata lookup", () => {
  it("keeps repeated WASI stats fresh across path mutations and symlink traversal", async () => {
    const test = fixture();
    try {
      await test.lower.prepare(["/work", "/work/nested", "/link", "/work/file", "/work/renamed"]);
      test.filesystem.mkdir("/work");
      test.filesystem.mkdir("/work/nested");
      test.filesystem.symlink("work/nested", "/link");
      const fd = test.filesystem.open(
        "/work/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      test.filesystem.close(fd);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await test.stat("link/../file")).value).toBe(0);
        expect((await test.stat("work//file")).value).toBe(0);
        expect((await test.stat("work/file/")).value).toBe(54);
      }
      test.filesystem.rename("/work//file", "/work/./renamed");
      expect((await test.stat("work/file")).value).toBe(44);
      expect((await test.stat("work/renamed")).value).toBe(0);
      test.filesystem.unlink("/link/../renamed");
      expect((await test.stat("work/renamed")).value).toBe(44);
    } finally {
      test.close();
    }
  });

  it("prepares only the candidate the guest requests without reading file bytes", async () => {
    const test = fixture();
    try {
      expect((await test.stat("first/tool")).value).toBe(44);
      expect(test.lookups).toEqual([["/first/tool", "/first"]]);
      expect((await test.stat("second/tool")).value).toBe(0);
      expect(test.lookups).toEqual([
        ["/first/tool", "/first"],
        ["/second/tool", "/second"],
      ]);
      expect((await test.stat("first/tool")).value).toBe(44);
      expect(test.lookups).toHaveLength(2);
    } finally {
      test.close();
    }
  });

  it("resolves a relative candidate against its directory descriptor", async () => {
    const test = fixture();
    let fd: number | undefined;
    try {
      await test.lower.prepare(["/second"]);
      fd = test.filesystem.open("/second", KernelOpenFlags.O_RDONLY);
      test.lookups.length = 0;
      expect((await test.stat("tool", fd)).value).toBe(0);
      expect(test.lookups).toEqual([["/second/tool"]]);
    } finally {
      if (fd !== undefined) test.filesystem.close(fd);
      test.close();
    }
  });

  it("includes the actual candidate after the shell changes PATH", async () => {
    const test = fixture();
    try {
      expect((await test.stat("dynamic/tool")).value).toBe(0);
      expect(test.lookups[0]).toContain("/dynamic/tool");
    } finally {
      test.close();
    }
  });
});
