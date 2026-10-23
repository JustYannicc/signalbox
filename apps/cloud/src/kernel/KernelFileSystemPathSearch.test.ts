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
      return [];
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

describe("Bash PATH metadata batching", () => {
  it("primes all PATH candidates during the first stat without reading file bytes", async () => {
    const test = fixture();
    try {
      expect((await test.stat("first/tool")).value).toBe(44);
      expect((await test.stat("second/tool")).value).toBe(0);
      expect(test.lookups).toHaveLength(1);
      expect(test.lookups[0]).toEqual(expect.arrayContaining(["/first/tool", "/second/tool"]));
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
      expect(test.lookups[0]).toEqual(expect.arrayContaining(["/first/tool", "/second/tool"]));
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
