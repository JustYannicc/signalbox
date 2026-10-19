import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { canonicalFileByteSelection, type KernelFileByteView } from "./KernelFileBytes.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function rig() {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, () => 123n);
  const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const inode = storage.create(storage.root, "file", { type: "file", exclusive: true });
  storage.write(inode, 0n, encoder.encode("canonical"));
  storage.release(inode);
  let data = encoder.encode("a longer representation");
  let binds = 0;
  let releases = 0;
  let releaseError: Error | undefined;
  const view: KernelFileByteView = {
    completion: "sync",
    storage,
    bind(boundInode) {
      binds++;
      return {
        stat: () => ({ ...storage.stat(boundInode), size: BigInt(data.length) }),
        readInto(offset, target) {
          const selected = data.subarray(Number(offset), Number(offset) + target.length);
          target.set(selected);
          return selected.length;
        },
        write() {
          throw new Error("unused fixture operation");
        },
        append() {
          throw new Error("unused fixture operation");
        },
        truncate(size) {
          data = data.slice(0, Number(size));
        },
        sync() {},
        release() {
          releases++;
          if (releaseError) throw releaseError;
        },
      };
    },
  };
  return {
    fs,
    storage,
    inode,
    view,
    inspect: () => ({ binds, releases }),
    failRelease(error: Error) {
      releaseError = error;
    },
    close() {
      fs.dispose();
      fixture.close();
    },
  };
}

describe("KernelFileSystem byte views", () => {
  it("keeps descriptor views across default switches and proc reopens with independent offsets", () => {
    const fixture = rig();
    const { fs, view } = fixture;
    try {
      const canonical = fs.open("/file", KernelOpenFlags.O_RDONLY);
      fs.setFileBytes({ kind: "view", view });
      const raw = fs.open("/file", KernelOpenFlags.O_RDONLY);
      expect(fs.stat("/file")).toMatchObject({ ino: fixture.inode, size: 23n });
      expect(fs.fstat(canonical).size).toBe(9n);
      expect(fs.fstat(raw).size).toBe(23n);
      const duplicate = fs.descriptors.duplicate(raw);
      expect(fs.read(raw, new Uint8Array(2), null)).toBe(2);
      expect(fs.descriptors.get(duplicate).offset).toBe(2n);
      fs.setFileBytes(canonicalFileByteSelection);
      const reopened = fs.open(`/proc/self/fd/${raw}`, KernelOpenFlags.O_RDONLY);
      const first = new Uint8Array(8);
      expect(fs.read(reopened, first, null)).toBe(8);
      expect(decoder.decode(first)).toBe("a longer");
      expect(fs.descriptors.get(raw).offset).toBe(2n);
      expect(fs.stat("/file").size).toBe(9n);
      expect(fs.stat(`/proc/self/fd/${raw}`).size).toBe(23n);
      expect(fs.lstat(`/proc/self/fd/${raw}`).type).toBe("symlink");
      fs.close(reopened);
      fs.close(raw);
      fs.close(duplicate);
      expect(fixture.inspect().releases).toBe(fixture.inspect().binds);
    } finally {
      fixture.close();
    }
  });

  it("truncates a proc alias in its descriptor view rather than the new-open default", () => {
    const fixture = rig();
    const { fs, view, storage, inode } = fixture;
    try {
      const canonical = fs.open("/file", KernelOpenFlags.O_RDWR);
      fs.setFileBytes({ kind: "view", view });
      const raw = fs.open("/file", KernelOpenFlags.O_RDWR);
      fs.truncate(`/proc/self/fd/${canonical}`, 4n);
      expect(storage.stat(inode).size).toBe(4n);
      expect(fs.fstat(raw).size).toBe(23n);
      fs.setFileBytes(canonicalFileByteSelection);
      fs.truncate(`/proc/self/fd/${raw}`, 3n);
      expect(fs.fstat(raw).size).toBe(3n);
      expect(storage.stat(inode).size).toBe(4n);
    } finally {
      fixture.close();
    }
  });

  it("checks read-only opens before binding and releases the inode even when the final view release fails", () => {
    const fixture = rig();
    const { fs, storage, inode, view } = fixture;
    const readOnly = new KernelFileSystem({
      mounts: [{ path: "/", storage, readOnly: true }],
      fileBytes: { kind: "view", view },
    });
    try {
      expect(() =>
        readOnly.open("/file", KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC),
      ).toThrow(expect.objectContaining({ code: "EROFS" }));
      expect(fixture.inspect()).toEqual({ binds: 0, releases: 0 });
      fs.setFileBytes({ kind: "view", view });
      const fd = fs.open("/file", KernelOpenFlags.O_RDONLY);
      expect(() => fs.write(fd, encoder.encode("x"), null)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      fs.unlink("/file");
      fixture.failRelease(new Error("view release failed"));
      expect(() => fs.close(fd)).toThrow("view release failed");
      expect(fixture.inspect().releases).toBe(1);
      expect(() => storage.stat(inode)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      readOnly.dispose();
      fixture.close();
    }
  });
});
