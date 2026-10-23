import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import {
  KernelFileSystemUnavailable,
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { KernelFileSystem, KernelOpenFlags, type KernelPosixOptions } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { parentPath } from "./KernelLowerFileSystemSourceIndex.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let nextNativeIno = 1n;

function lowerEntry(
  path: string,
  type: KernelLowerFileSystemEntry["stat"]["type"],
  size = 0n,
  posix: { readonly mode?: number; readonly uid?: number; readonly gid?: number } = {},
): KernelLowerFileSystemEntry {
  return {
    path,
    stat: {
      type,
      size,
      nlink: type === "directory" ? 2n : 1n,
      atimeNs: 1n,
      mtimeNs: 2n,
      ctimeNs: 3n,
    },
    metadata: {
      mode: posix.mode ?? (type === "symlink" ? 0o777 : 0o755),
      uid: posix.uid ?? 41,
      gid: posix.gid ?? 42,
    },
    nativeIno: nextNativeIno++,
    nativeDev: 7n,
  };
}

function lowerSource(
  entries: readonly KernelLowerFileSystemEntry[],
  files: ReadonlyMap<string, Uint8Array> = new Map(),
  links: ReadonlyMap<string, string> = new Map(),
  options: { readonly asyncLookup?: boolean; readonly lookupKnown?: boolean } = {},
) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const calls = { lookup: [] as string[][], readdir: [] as string[], read: [] as string[] };
  const source: KernelLowerFileSystemSource = {
    lookup(paths) {
      calls.lookup.push([...paths]);
      const entries = paths.map((path) => byPath.get(path));
      return options.asyncLookup === true ? Promise.resolve(entries) : entries;
    },
    ...(options.lookupKnown === false
      ? {}
      : { lookupKnown: (paths: readonly string[]) => paths.map((path) => byPath.get(path)) }),
    async readdir(path) {
      calls.readdir.push(path);
      if (byPath.get(path)?.stat.type !== "directory") return undefined;
      return entries.filter((entry) => entry.path !== path && parentPath(entry.path) === path);
    },
    async readlink(path) {
      const target = links.get(path);
      if (target === undefined) throw Object.assign(new Error("Not a symlink"), { code: "EINVAL" });
      return target;
    },
    async read(path, offset, length) {
      calls.read.push(path);
      const bytes = files.get(path) ?? new Uint8Array();
      return bytes.slice(Number(offset), Number(offset) + length);
    },
  };
  return { source, calls, byPath };
}

function filesystem(posix?: KernelPosixOptions) {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, () => 1n);
  if (posix !== undefined) storage.posix.initialize(storage.root, { mode: 0o755, uid: 0, gid: 0 });
  const fs = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    ...(posix === undefined ? {} : { posix }),
  });
  return {
    fs,
    storage,
    close() {
      fs.dispose();
      fixture.close();
    },
  };
}

function createUpperFile(
  storage: ReturnType<typeof createFacetSqliteStorage>,
  path: string,
  contents: string,
) {
  const components = path.split("/").filter(Boolean);
  let parent = storage.root;
  for (const component of components.slice(0, -1)) {
    let directory: bigint;
    try {
      directory = storage.lookup(parent, component);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      directory = storage.create(parent, component, { type: "directory", exclusive: true });
      storage.release(directory);
    }
    parent = directory;
  }
  const name = components.at(-1);
  if (name === undefined) throw new Error("Expected a file path");
  const inode = storage.create(parent, name, { type: "file", exclusive: true });
  storage.write(inode, 0n, encoder.encode(contents));
  storage.release(inode);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("KernelLowerFileSystem", () => {
  it("keeps an upper cwd and relative files synchronous after lower attachment", async () => {
    const fixture = filesystem();
    createUpperFile(fixture.storage, "/workspace/own-tool", "upper");
    fixture.fs.chdir("/workspace");
    const calls: string[] = [];
    const lower = fixture.fs.installLowerFileSystem({
      async lookup(paths) {
        calls.push(...paths);
        throw new Error("upper-owned paths must not reach the lower source");
      },
      async readdir(path) {
        calls.push(path);
        throw new Error("upper-owned directories must not reach the lower source");
      },
      async readlink(path) {
        calls.push(path);
        throw new Error("upper-owned links must not reach the lower source");
      },
      async read(path) {
        calls.push(path);
        throw new Error("upper-owned bytes must not reach the lower source");
      },
    });
    try {
      await lower.prepare(["/workspace/own-tool"]);
      expect(fixture.fs.cwd).toBe("/workspace");
      expect(fixture.fs.stat("own-tool")).toMatchObject({ type: "file", size: 5n });
      const fd = fixture.fs.open("own-tool", KernelOpenFlags.O_RDONLY);
      const bytes = new Uint8Array(5);
      expect(fixture.fs.read(fd, bytes, null)).toBe(5);
      expect(decoder.decode(bytes)).toBe("upper");
      fixture.fs.close(fd);
      expect(calls).toEqual([]);
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("keeps public upper writes synchronous when the source proves the paths missing", () => {
    const fixture = filesystem({
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
      umask: 0o022,
    });
    fixture.fs.mkdir("/workspace");
    const { source, calls } = lowerSource([]);
    const lower = fixture.fs.installLowerFileSystem(source);
    try {
      fixture.fs.mkdir("/workspace/early");
      const fd = fixture.fs.open(
        "/workspace/early/sort",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o644,
      );
      fixture.fs.write(fd, encoder.encode("owner"), null);
      fixture.fs.close(fd);
      expect(fixture.fs.stat("/workspace/early/sort")).toMatchObject({
        type: "file",
        size: 5n,
        posix: { mode: 0o644, uid: 1000, gid: 1000 },
      });
      expect(calls.lookup).toHaveLength(0);
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("batches metadata, merges directory entries upper-first, and reads lower bytes on demand", async () => {
    const fixture = filesystem();
    createUpperFile(fixture.storage, "/usr/bin/conflict", "upper");
    createUpperFile(fixture.storage, "/usr/bin/upper-only", "owner");
    const contents = new Map([
      ["/usr/bin/tool", encoder.encode("tool")],
      ["/usr/bin/conflict", encoder.encode("lower")],
      ["/usr/bin/lower-only", encoder.encode("lower")],
    ]);
    const { source, calls } = lowerSource(
      [
        lowerEntry("/usr", "directory"),
        lowerEntry("/usr/bin", "directory"),
        lowerEntry("/usr/bin/tool", "file", 4n),
        lowerEntry("/usr/bin/conflict", "file", 5n),
        lowerEntry("/usr/bin/lower-only", "file", 5n),
      ],
      contents,
    );
    const lower = fixture.fs.installLowerFileSystem(source);
    let child: KernelFileSystem | undefined;
    try {
      await lower.prepare(["/usr/bin/tool", "/usr/bin/lower-only", "/usr/bin/new-file"]);
      expect(calls.lookup).toHaveLength(1);
      expect(calls.read).toEqual([]);
      expect(fixture.fs.stat("/usr/bin/tool")).toMatchObject({
        type: "file",
        size: 4n,
        posix: { mode: 0o755, uid: 41, gid: 42 },
      });
      child = fixture.fs.fork(fixture.fs.descriptors.fork([]));
      expect(child.stat("/usr/bin/tool")).toMatchObject({ type: "file", size: 4n });
      expect(calls.lookup).toHaveLength(1);
      expect(() => fixture.fs.unlink("/usr/bin/tool")).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      const created = fixture.fs.open(
        "/usr/bin/new-file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o644,
      );
      fixture.fs.write(created, encoder.encode("created"), null);
      fixture.fs.close(created);
      expect(fixture.fs.stat("/usr/bin/new-file").size).toBe(7n);

      const directory = fixture.fs.resolve("/usr/bin");
      const entries = await directory.mount.storage.readdir(directory.inode);
      expect(entries.map((entry) => entry.name).sort()).toEqual([
        "conflict",
        "lower-only",
        "new-file",
        "tool",
        "upper-only",
      ]);
      const conflict = entries.find((entry) => entry.name === "conflict");
      const upperUsr = fixture.storage.lookup(fixture.storage.root, "usr");
      const upperBin = fixture.storage.lookup(upperUsr, "bin");
      expect(conflict?.inode).toBe(fixture.storage.lookup(upperBin, "conflict"));
      expect(calls.readdir).toContain("/usr/bin");

      const tool = fixture.fs.resolve("/usr/bin/tool");
      const bytes = new Uint8Array(4);
      expect(await tool.mount.storage.readInto(tool.inode, 0n, bytes)).toBe(4);
      expect(decoder.decode(bytes)).toBe("tool");
      expect(calls.read).toEqual(["/usr/bin/tool"]);
    } finally {
      child?.dispose();
      lower.dispose();
      fixture.close();
    }
  });

  it("walks dot paths and follows a symlink before resolving a later parent segment", async () => {
    const fixture = filesystem();
    createUpperFile(fixture.storage, "/workspace/marker", "upper");
    const entries = [
      lowerEntry("/workspace", "directory"),
      lowerEntry("/workspace/tool", "file", 4n),
      lowerEntry("/link", "symlink", 16n),
      lowerEntry("/machine", "directory"),
      lowerEntry("/machine/dir", "directory"),
      lowerEntry("/machine/dir/sub", "directory"),
      lowerEntry("/machine/dir/tool", "file", 4n),
    ];
    const { source, calls } = lowerSource(
      entries,
      new Map(),
      new Map([["/link", "/machine/dir/sub"]]),
    );
    const lower = fixture.fs.installLowerFileSystem(source);
    try {
      await lower.prepare(["/workspace/./tool", "/link/../tool"]);
      expect(await lower.isLower("/workspace/./tool")).toBe(true);
      expect(await lower.isLower("/link/../tool")).toBe(true);
      expect(calls.lookup.flat()).toContain("/machine/dir/tool");
      expect(fixture.fs.lstat("/link")).toMatchObject({ type: "symlink", size: 16n });
      expect(fixture.fs.readlink("/link")).toBe("/machine/dir/sub");
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("expires cached misses when the machine execution epoch changes", async () => {
    const fixture = filesystem();
    const { source, calls, byPath } = lowerSource([lowerEntry("/machine", "directory")]);
    const lower = fixture.fs.installLowerFileSystem(source);
    try {
      await lower.prepare(["/machine/new-tool"]);
      expect(calls.lookup).toHaveLength(1);

      byPath.set("/machine/new-tool", lowerEntry("/machine/new-tool", "file", 3n));
      await expect(lower.isLower("/machine/new-tool")).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls.lookup).toHaveLength(1);

      lower.invalidate();
      await lower.prepare(["/machine/new-tool"]);
      expect(await lower.isLower("/machine/new-tool")).toBe(true);
      expect(calls.lookup).toHaveLength(2);
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("retries an in-flight negative lookup after invalidation", async () => {
    const fixture = filesystem();
    const entries = [lowerEntry("/machine", "directory"), lowerEntry("/machine/tool", "file", 4n)];
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const staleLookup =
      Promise.withResolvers<readonly (KernelLowerFileSystemEntry | undefined)[]>();
    const calls: string[][] = [];
    let lookupCount = 0;
    const lower = fixture.fs.installLowerFileSystem({
      lookup(paths) {
        calls.push([...paths]);
        lookupCount++;
        return lookupCount === 1
          ? staleLookup.promise
          : Promise.resolve(paths.map((path) => byPath.get(path)));
      },
      async readdir() {
        return undefined;
      },
      async readlink() {
        throw Object.assign(new Error("unused"), { code: "EINVAL" });
      },
      async read() {
        return new Uint8Array();
      },
    });
    try {
      const preparing = lower.prepare(["/machine/tool"]);
      expect(calls).toHaveLength(1);
      lower.invalidate();
      staleLookup.resolve([undefined, undefined]);
      await preparing;

      expect(calls).toHaveLength(2);
      expect(await lower.isLower("/machine/tool")).toBe(true);
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("detaches only its own source before the filesystem is reused", async () => {
    const fixture = filesystem();
    const first = fixture.fs.installLowerFileSystem(lowerSource([]).source);
    first.dispose();
    const { source, calls } = lowerSource([
      lowerEntry("/machine", "directory"),
      lowerEntry("/machine/tool", "file", 4n),
    ]);
    const second = fixture.fs.installLowerFileSystem(source);
    try {
      first.dispose();
      await second.prepare(["/machine/tool"]);
      expect(await second.isLower("/machine/tool")).toBe(true);
      expect(calls.lookup).toHaveLength(1);
    } finally {
      second.dispose();
      fixture.close();
    }
  });

  it("propagates lookup failure out of a PATH stat instead of returning ENOENT", async () => {
    const fixture = filesystem();
    const lower = fixture.fs.installLowerFileSystem({
      async lookup() {
        throw Object.assign(new Error("machine lookup transport failed"), { code: "ENOENT" });
      },
      async readdir() {
        return undefined;
      },
      async readlink() {
        throw Object.assign(new Error("unused"), { code: "EINVAL" });
      },
      async read() {
        return new Uint8Array();
      },
    });
    const controller = new AbortController();
    const prepared: string[] = [];
    const syscalls = createKernelSyscallHost({
      filesystem: fixture.fs,
      args: [],
      env: {},
      signal: controller.signal,
      preparePathSearch: async (path, directoryFd) => {
        prepared.push(`${directoryFd}:${path}`);
      },
    });
    const path = encoder.encode("machine/tool");
    try {
      await expect(
        syscalls.call({
          name: "path_filestat_get",
          args: [3, 0, 128, path.byteLength, 256],
          memorySize: 320,
          regions: [
            { pointer: 128, bytes: path, direction: "in" },
            { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 64 },
          ],
        }),
      ).rejects.toBeInstanceOf(KernelFileSystemUnavailable);
      expect(prepared).toEqual(["3:machine/tool"]);
    } finally {
      syscalls.close();
      lower.dispose();
      fixture.close();
    }
  });

  it("checks effective permissions for public stat, directory listings, and WASI stat", async () => {
    const fixture = filesystem({
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
      umask: 0o022,
    });
    const { source } = lowerSource([
      lowerEntry("/private", "directory", 0n, { mode: 0o700, uid: 0, gid: 0 }),
      lowerEntry("/private/secret", "file", 6n, { mode: 0o644, uid: 0, gid: 0 }),
      lowerEntry("/private/listable", "directory", 0n, { mode: 0o755, uid: 0, gid: 0 }),
    ]);
    const lower = fixture.fs.installLowerFileSystem(source);
    const syscalls = createKernelSyscallHost({
      filesystem: fixture.fs,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const path = encoder.encode("private/secret");
    try {
      await lower.prepare(["/private", "/private/secret", "/private/listable"]);
      expect(fixture.fs.stat("/private")).toMatchObject({
        type: "directory",
        posix: { mode: 0o700, uid: 0, gid: 0 },
      });
      expect(() => fixture.fs.stat("/private/secret")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => fixture.fs.lstat("/private/secret")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => fixture.fs.readdir("/private")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => fixture.fs.readdir("/private/listable")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );

      const response = await syscalls.call({
        name: "path_filestat_get",
        args: [3, 0, 128, path.byteLength, 256],
        memorySize: 320,
        regions: [
          { pointer: 128, bytes: path, direction: "in" },
          { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 64 },
        ],
      });
      expect(response).toMatchObject({ kind: "return", value: 2 });
    } finally {
      syscalls.close();
      lower.dispose();
      fixture.close();
    }
  });

  it("can list readable names without search permission on the final directory", async () => {
    const fixture = filesystem({
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
      umask: 0o022,
    });
    const { source } = lowerSource([
      lowerEntry("/names", "directory", 0n, { mode: 0o744, uid: 0, gid: 0 }),
      lowerEntry("/names/item", "file", 6n, { mode: 0o644, uid: 0, gid: 0 }),
    ]);
    const lower = fixture.fs.installLowerFileSystem(source);
    try {
      await lower.prepare(["/names"]);
      expect(fixture.fs.readdir("/names")).toEqual(["item"]);
      expect(() => fixture.fs.stat("/names/item")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("uses known image metadata in sync mode without starting lower I/O", () => {
    const fixture = filesystem();
    const entries = [
      lowerEntry("/image", "directory"),
      lowerEntry("/image/tool", "file", 4n),
      lowerEntry("/image/link", "symlink", 10n),
    ];
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const calls = {
      lookup: [] as string[][],
      readdir: [] as string[],
      readlink: [] as string[],
      read: [] as string[],
    };
    const lower = fixture.fs.installLowerFileSystem({
      lookup(paths) {
        calls.lookup.push([...paths]);
        return Promise.resolve(paths.map((path) => byPath.get(path)));
      },
      lookupKnown(paths) {
        return paths.map((path) => byPath.get(path));
      },
      async readdir(path) {
        calls.readdir.push(path);
        return [];
      },
      async readlink(path) {
        calls.readlink.push(path);
        return "/image/tool";
      },
      async read(path) {
        calls.read.push(path);
        return encoder.encode("tool");
      },
    });
    let fd: number | undefined;
    try {
      expect(fixture.fs.stat("/image/tool")).toMatchObject({ type: "file", size: 4n });
      expect(() => fixture.fs.readdir("/image")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(() => fixture.fs.readlink("/image/link")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      const openedFd = fixture.fs.open("/image/tool", KernelOpenFlags.O_RDONLY);
      fd = openedFd;
      expect(() => fixture.fs.read(openedFd, new Uint8Array(4), null)).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(calls).toEqual({ lookup: [], readdir: [], readlink: [], read: [] });
    } finally {
      if (fd !== undefined) fixture.fs.close(fd);
      lower.dispose();
      fixture.close();
    }
  });

  it("checks executables asynchronously after machine-cache invalidation", async () => {
    const fixture = filesystem({
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
      umask: 0o022,
    });
    const { source, calls } = lowerSource(
      [
        lowerEntry("/machine", "directory"),
        lowerEntry("/machine/tool", "file", 4n, { mode: 0o755, uid: 1000, gid: 1000 }),
        lowerEntry("/private", "directory", 0n, { mode: 0o700, uid: 0, gid: 0 }),
        lowerEntry("/private/secret", "file", 6n, { mode: 0o755, uid: 0, gid: 0 }),
      ],
      new Map(),
      new Map(),
      { asyncLookup: true, lookupKnown: false },
    );
    const lower = fixture.fs.installLowerFileSystem(source);
    try {
      await lower.prepare(["/machine/tool", "/private/secret"]);
      expect(await lower.isLower("/machine/tool")).toBe(true);

      lower.invalidate();
      await expect(fixture.fs.checkExecutable("/machine/tool")).resolves.toMatchObject({
        type: "file",
        size: 4n,
        posix: { mode: 0o755, uid: 1000, gid: 1000 },
      });
      expect(calls.lookup.length).toBeGreaterThan(1);

      lower.invalidate();
      await expect(fixture.fs.checkExecutable("/private/secret")).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      lower.dispose();
      fixture.close();
    }
  });

  it("does not start live lower I/O from a synchronous lookup after invalidation", async () => {
    const fixture = filesystem();
    const { source, calls } = lowerSource(
      [lowerEntry("/machine", "directory"), lowerEntry("/machine/tool", "file")],
      new Map(),
      new Map(),
      { asyncLookup: true, lookupKnown: false },
    );
    const lower = fixture.fs.installLowerFileSystem(source);
    try {
      await lower.prepare(["/machine/tool"]);
      lower.invalidate();
      const lookupCount = calls.lookup.length;

      expect(() => fixture.fs.stat("/machine/tool")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(calls.lookup).toHaveLength(lookupCount);
    } finally {
      lower.dispose();
      fixture.close();
    }
  });
});
