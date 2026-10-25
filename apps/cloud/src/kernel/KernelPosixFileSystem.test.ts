import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const rootMetadata = { mode: 0o755, uid: 0, gid: 0 } as const;
const user = {
  uid: 1000,
  gid: 100,
  euid: 1000,
  egid: 100,
  groups: [101],
} as const;
const otherUser = { uid: 2000, gid: 200, euid: 2000, egid: 200 } as const;

describe("KernelFileSystem POSIX metadata", () => {
  it("requires explicit metadata initialization for existing inodes", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0o022 },
    });
    try {
      expect(() => fs.getPosixMetadata("/")).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
      storage.posix.initialize(storage.root, rootMetadata);
      expect(fs.getPosixMetadata("/")).toEqual(rootMetadata);
      expect(() => storage.posix.initialize(storage.root, rootMetadata)).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("applies requested open modes and umask once, then persists the metadata", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0o027 },
    });
    try {
      const fd = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o6754);
      const inode = fs.resolve("/file").inode;
      expect(fs.getPosixMetadataForFd(fd)).toEqual({ mode: 0o6750, uid: 1000, gid: 100 });

      expect(fs.setUmask(0o007)).toBe(0o027);
      const nextFd = fs.open("/next", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o666);
      expect(fs.getPosixMetadataForFd(nextFd)).toEqual({ mode: 0o660, uid: 1000, gid: 100 });

      fs.chmod("/file", 0o4754);
      const existingFd = fs.open(
        "/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY,
        0o777,
      );
      expect(fs.getPosixMetadata("/file")).toEqual({ mode: 0o4754, uid: 1000, gid: 100 });
      expect(createFacetSqliteStorage(fixture.storage, now).posix.get(inode)).toEqual({
        mode: 0o4754,
        uid: 1000,
        gid: 100,
      });
      fs.close(fd);
      fs.close(existingFd);
      fs.close(nextFd);
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("keeps metadata unknown when POSIX behavior is opted out", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      const fd = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o600);
      expect(fs.fstat(fd).type).toBe("file");
      expect(() => fs.getPosixMetadata("/file")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(() => fs.setUmask(0o022)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("shares mode and ownership through hard links", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0 },
    });
    try {
      const fd = fs.open("/original", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o6755);
      fs.link("/original", "/alias");
      expect(fs.stat("/alias").ino).toBe(fs.stat("/original").ino);

      fs.chmod("/alias", 0o4750);
      fs.chown("/alias", 1000, 101);
      expect(fs.getPosixMetadata("/original")).toEqual({ mode: 0o0750, uid: 1000, gid: 101 });
      expect(fs.getPosixMetadata("/alias")).toEqual({ mode: 0o0750, uid: 1000, gid: 101 });
      fs.close(fd);
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("keeps unlinked metadata available through a retained descriptor", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0 },
    });
    try {
      const fd = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o640);
      const inode = fs.resolve("/file").inode;
      fs.unlink("/file");

      expect(fs.getPosixMetadataForFd(fd)).toEqual({ mode: 0o640, uid: 1000, gid: 100 });
      expect(() => fs.getPosixMetadata("/file")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      fs.fchmod(fd, 0o600);
      expect(storage.posix.get(inode)).toEqual({ mode: 0o600, uid: 1000, gid: 100 });

      fs.close(fd);
      expect(() => storage.posix.get(inode)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("requires descriptor metadata rights while preserving read-only errors", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0 },
    });
    const readOnly = new KernelFileSystem({
      mounts: [{ path: "/", storage, readOnly: true }],
      posix: { credentials: user, umask: 0 },
    });
    try {
      const createdFd = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o640);
      fs.close(createdFd);
      const pathFd = fs.open("/file", KernelOpenFlags.O_PATH);
      const readFd = fs.open("/file", KernelOpenFlags.O_RDONLY);
      const readOnlyFd = readOnly.open("/file", KernelOpenFlags.O_RDONLY);

      expect(() => fs.fchmod(pathFd, 0o600)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(() => fs.fchown(pathFd, 1000, 101)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(fs.getPosixMetadata("/file")).toEqual({ mode: 0o640, uid: 1000, gid: 100 });

      fs.fchmod(readFd, 0o600);
      fs.fchown(readFd, 1000, 101);
      expect(fs.getPosixMetadata("/file")).toEqual({ mode: 0o600, uid: 1000, gid: 101 });

      expect(() => readOnly.fchmod(readOnlyFd, 0o400)).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(() => readOnly.fchown(readOnlyFd, 1000, 100)).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(fs.getPosixMetadata("/file")).toEqual({ mode: 0o600, uid: 1000, gid: 101 });

      fs.close(pathFd);
      fs.close(readFd);
      readOnly.close(readOnlyFd);
    } finally {
      readOnly.dispose();
      fs.dispose();
      fixture.close();
    }
  });

  it("maps closed and invalid metadata descriptors to EBADF", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0 },
    });
    try {
      const fd = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o640);
      fs.close(fd);

      for (const invalidFd of [fd, 999]) {
        expect(() => fs.getPosixMetadataForFd(invalidFd)).toThrow(
          expect.objectContaining({ code: "EBADF" }),
        );
        expect(() => fs.fchmod(invalidFd, 0o600)).toThrow(
          expect.objectContaining({ code: "EBADF" }),
        );
        expect(() => fs.fchown(invalidFd, 1000, 101)).toThrow(
          expect.objectContaining({ code: "EBADF" }),
        );
      }
      expect(fs.getPosixMetadata("/file")).toEqual({ mode: 0o640, uid: 1000, gid: 100 });
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("enforces owner and group authority and read-only mounts", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0 },
    });
    const readOnly = new KernelFileSystem({
      mounts: [{ path: "/", storage, readOnly: true }],
      posix: { credentials: user, umask: 0 },
    });
    try {
      const fd = fs.open("/owned", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o6755);
      fs.chmod("/owned", 0o6750);
      fs.chown("/owned", 1000, 101);
      expect(fs.getPosixMetadata("/owned")).toEqual({ mode: 0o0750, uid: 1000, gid: 101 });

      expect(() => fs.chmod("/", 0o700)).toThrow(expect.objectContaining({ code: "EPERM" }));
      expect(() => fs.chown("/owned", 2000, 101)).toThrow(
        expect.objectContaining({ code: "EPERM" }),
      );
      expect(() => readOnly.chmod("/owned", 0o600)).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(() => readOnly.chown("/owned", 1000, 101)).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      fs.close(fd);
    } finally {
      readOnly.dispose();
      fs.dispose();
      fixture.close();
    }
  });

  it("can change symlink metadata without following it", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0 },
    });
    const other = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: otherUser, umask: 0 },
    });
    const readOnly = new KernelFileSystem({
      mounts: [{ path: "/", storage, readOnly: true }],
      posix: { credentials: user, umask: 0 },
    });
    try {
      const fd = fs.open("/target", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o640);
      fs.symlink("target", "/link");

      fs.chmod("/link", 0o600);
      expect(fs.getPosixMetadata("/target").mode).toBe(0o600);
      expect(fs.getPosixMetadata("/link", false).mode).toBe(0o777);

      fs.chmod("/link", 0o750, false);
      fs.chown("/link", 1000, 101, false);
      expect(fs.getPosixMetadata("/link", false)).toEqual({ mode: 0o750, uid: 1000, gid: 101 });
      expect(fs.getPosixMetadata("/target")).toEqual({ mode: 0o600, uid: 1000, gid: 100 });

      expect(() => other.chmod("/link", 0o700, false)).toThrow(
        expect.objectContaining({ code: "EPERM" }),
      );
      expect(() => other.chown("/link", 2000, 200, false)).toThrow(
        expect.objectContaining({ code: "EPERM" }),
      );
      expect(() => readOnly.chmod("/link", 0o700, false)).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(() => readOnly.chown("/link", 1000, 101, false)).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(fs.getPosixMetadata("/link", false)).toEqual({
        mode: 0o750,
        uid: 1000,
        gid: 101,
      });
      fs.close(fd);
    } finally {
      readOnly.dispose();
      other.dispose();
      fs.dispose();
      fixture.close();
    }
  });

  it("copies umask into a fork and keeps later changes process-local", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    storage.posix.initialize(storage.root, rootMetadata);
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: user, umask: 0o077 },
    });
    const child = fs.fork(fs.descriptors.fork([]));
    try {
      expect(fs.setUmask(0o007)).toBe(0o077);
      const parentFd = fs.open("/parent", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o666);
      const childFd = child.open("/child", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR, 0o666);
      expect(fs.getPosixMetadataForFd(parentFd).mode).toBe(0o660);
      expect(child.getPosixMetadataForFd(childFd).mode).toBe(0o600);

      expect(child.setUmask(0)).toBe(0o077);
      expect(fs.setUmask(0o002)).toBe(0o007);
      expect(child.posixPolicy?.umask).toBe(0);
      expect(fs.posixPolicy?.umask).toBe(0o002);
      fs.close(parentFd);
      child.close(childFd);
    } finally {
      child.dispose();
      fs.dispose();
      fixture.close();
    }
  });
});
