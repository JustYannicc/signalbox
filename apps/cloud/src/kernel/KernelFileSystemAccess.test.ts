import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { AgentOsFileSystemHost } from "./AgentOsFileSystemHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function fixture(posix = true) {
  const db = sqliteFixture();
  const storage = createFacetSqliteStorage(db.storage, () => 1n);
  if (posix) storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const fs = new KernelFileSystem({
    mounts: [
      { path: "/", storage },
      { path: "/nested", storage },
    ],
    ...(posix
      ? { posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 } }
      : {}),
  });
  fs.mkdir("/work");
  const fd = fs.open("/work/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o600);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = new AgentOsFileSystemHost({ memory: () => memory, fileSystem: fs });
  return {
    fs,
    fd,
    storage,
    access(path: string, mode: number) {
      const bytes = new TextEncoder().encode(path);
      new Uint8Array(memory.buffer, 64, bytes.length).set(bytes);
      return host.imports.path_access(-100, 64, bytes.length, mode, 0);
    },
    close() {
      fs.dispose();
      db.close();
    },
  };
}

describe("filesystem access compatibility", () => {
  it("keeps existence lookup available without a POSIX policy", () => {
    const test = fixture(false);
    try {
      expect(test.access("/work/file", 0)).toBe(0);
      expect(test.access("/missing", 0)).toBe(44);
      expect(test.access("/work/file", 4)).toBe(58);
      expect(test.access("/missing", 4)).toBe(44);
    } finally {
      test.close();
    }
  });

  it("distinguishes directory existence from traversing a literal dot", () => {
    const test = fixture();
    try {
      test.fs.chmod("/work", 0);
      expect(test.access("/work", 0)).toBe(0);
      expect(test.access("/work/", 0)).toBe(0);
      expect(test.access("/work/.", 0)).toBe(2);
      expect(test.access("/work/file", 0)).toBe(2);
      test.fs.chmod("/", 0);
      expect(test.access("/", 0)).toBe(0);
      expect(test.access("///", 0)).toBe(0);
      expect(test.access("/.", 0)).toBe(2);
    } finally {
      test.close();
    }
  });

  it("uses canonical virtual-device and descriptor-alias dispatch", () => {
    const test = fixture();
    try {
      expect(test.access("/dev/null", 0)).toBe(0);
      expect(test.access("/dev/null", 4)).toBe(58);
      expect(test.access(`/proc/self/fd/${test.fd}`, 0)).toBe(0);
      expect(test.access(`/proc/self/fd/${test.fd}`, 4)).toBe(0);
      test.fs.chmod("/work/file", 0);
      expect(test.access(`/proc/self/fd/${test.fd}`, 4)).toBe(2);
      const device = test.fs.open("/dev/null", KernelOpenFlags.O_RDWR);
      expect(test.access(`/proc/self/fd/${device}`, 0)).toBe(0);
      test.fs.close(test.fd);
      expect(test.access(`/proc/self/fd/${test.fd}`, 0)).toBe(44);
    } finally {
      test.close();
    }
  });

  it("preserves the nested-mount absolute-symlink guard", () => {
    const test = fixture();
    try {
      const inode = test.storage.create(test.storage.root, "absolute-link", {
        type: "symlink",
        target: "/work/file",
        exclusive: true,
      });
      test.storage.release(inode);
      expect(() => test.fs.stat("/nested/absolute-link")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(test.access("/nested/absolute-link", 0)).toBe(58);
    } finally {
      test.close();
    }
  });
});
