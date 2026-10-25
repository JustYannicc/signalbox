import { expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import type { KernelLowerFileSystemEntry } from "./KernelLowerFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function entry(
  path: string,
  type: KernelLowerFileSystemEntry["stat"]["type"],
  size = 0n,
): KernelLowerFileSystemEntry {
  return {
    path,
    stat: { type, size, nlink: 1n, atimeNs: 1n, mtimeNs: 2n, ctimeNs: 3n },
    metadata: { mode: 0o755, uid: 1000, gid: 1000 },
  };
}

function fixture(upperTarget = false) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const fs = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  fs.mkdir("/alias");
  if (upperTarget) {
    fs.mkdir("/source");
    fs.mkdir("/source/data");
    const fd = fs.open(
      "/source/data/value",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      0o755,
    );
    fs.write(fd, new Uint8Array(19), null);
    fs.close(fd);
  }
  const link = { ...entry("/alias/tool", "symlink", 13n), symlinkParent: "/source/bin" };
  const entries = new Map(
    [
      link,
      ...[
        "/source",
        "/source/bin",
        "/source/data",
        "/other",
        "/other/bin",
        "/other/data",
        "/data",
      ].map((path) => entry(path, "directory")),
      entry("/source/data/value", "file", 7n),
      entry("/other/data/value", "file", 11n),
      entry("/data/value", "file", 5n),
    ].map((item) => [item.path, item]),
  );
  let target = "../data/value";
  const lower = fs.installLowerFileSystem({
    lookup: (paths) => paths.map((path) => entries.get(path)),
    async readdir() {
      return [];
    },
    async readlink() {
      return target;
    },
    async read() {
      throw new Error("Metadata traversal must not read file bytes");
    },
  });
  return {
    fs,
    lower,
    entries,
    setTarget(value: string) {
      target = value;
    },
    close() {
      lower.dispose();
      fs.dispose();
      database.close();
    },
  };
}

it("follows the supplied physical lower parent while retaining original lstat and readlink", async () => {
  const test = fixture();
  try {
    await test.lower.prepare(["/alias/tool"]);
    expect(test.fs.lstat("/alias/tool")).toMatchObject({ type: "symlink", size: 13n });
    expect(test.fs.readlink("/alias/tool")).toBe("../data/value");
    await expect(test.fs.checkExecutable("/alias/tool")).resolves.toMatchObject({
      type: "file",
      size: 7n,
    });
    await expect(test.lower.isLower("/alias/tool")).resolves.toBe(true);
  } finally {
    test.close();
  }
});

it("uses upper precedence at the actual physical target", async () => {
  const test = fixture(true);
  try {
    await expect(test.fs.checkExecutable("/alias/tool")).resolves.toMatchObject({ size: 19n });
    await expect(test.lower.isLower("/alias/tool")).resolves.toBe(false);
  } finally {
    test.close();
  }
});

it("invalidates physical-parent provenance together with link metadata", async () => {
  const test = fixture();
  try {
    await expect(test.fs.checkExecutable("/alias/tool")).resolves.toMatchObject({ size: 7n });
    test.entries.set("/alias/tool", {
      ...entry("/alias/tool", "symlink", 13n),
      symlinkParent: "/other/bin",
    });
    test.lower.invalidate();
    await expect(test.fs.checkExecutable("/alias/tool")).resolves.toMatchObject({ size: 11n });
    expect(test.fs.readlink("/alias/tool")).toBe("../data/value");
  } finally {
    test.close();
  }
});

it("keeps absolute link targets independent of relative-parent provenance", async () => {
  const test = fixture();
  try {
    test.setTarget("/data/value");
    await expect(test.fs.checkExecutable("/alias/tool")).resolves.toMatchObject({ size: 5n });
    await expect(test.lower.isLower("/alias/tool")).resolves.toBe(true);
  } finally {
    test.close();
  }
});

it.each(["relative", "/source/../other", "/source//bin"])(
  "rejects noncanonical physical parent %s",
  async (symlinkParent) => {
    const test = fixture();
    try {
      test.entries.set("/alias/tool", { ...entry("/alias/tool", "symlink"), symlinkParent });
      await expect(test.lower.prepare(["/alias/tool"])).rejects.toMatchObject({
        name: "KernelFileSystemUnavailable",
      });
    } finally {
      test.close();
    }
  },
);
