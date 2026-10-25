import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const NONBLOCK = 4;
const readFlags = 0xa0900;
const bytes = (value: string) => new TextEncoder().encode(value);

function createFixture() {
  const sql = sqliteFixture();
  const storage = createFacetSqliteStorage(sql.storage, () => 1_800_000_000_000_000_001n);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: [
      { readInto: () => 0 },
      { write: (source) => source.byteLength },
      { write: (source) => source.byteLength },
    ],
  });
  return {
    filesystem,
    storage,
    close() {
      try {
        filesystem.dispose();
      } finally {
        sql.close();
      }
    },
  };
}

describe("nonblocking storage opens", () => {
  it("retains NONBLOCK while regular-file I/O and shared offsets remain ordinary", () => {
    const test = createFixture();
    const fs = test.filesystem;
    try {
      const fd = fs.open(
        "/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR | KernelOpenFlags.O_NONBLOCK,
      );
      expect(fs.write(fd, bytes("abcdef"), 0n)).toBe(6);
      expect(fs.descriptors.get(fd).flags).toBe(NONBLOCK);
      const duplicate = fs.descriptors.duplicate(fd);
      expect(fs.descriptors.get(duplicate).flags).toBe(NONBLOCK);
      const first = new Uint8Array(3);
      const second = new Uint8Array(3);
      expect(fs.read(fd, first, null)).toBe(3);
      expect(fs.read(duplicate, second, null)).toBe(3);
      expect(new TextDecoder().decode(first)).toBe("abc");
      expect(new TextDecoder().decode(second)).toBe("def");
      expect(fs.read(fd, new Uint8Array(1), null)).toBe(0);
    } finally {
      test.close();
    }
  });

  it("accepts the observed directory and proc-fd leaf flags without following the final link", () => {
    const test = createFixture();
    const fs = test.filesystem;
    try {
      fs.mkdir("/work");
      const writer = fs.open(
        "/work/source.txt",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      fs.write(writer, bytes("source bytes"), 0n);
      fs.close(writer);
      const directory = fs.open("/work", 0x800);
      expect(fs.fstat(directory).type).toBe("directory");
      expect(fs.descriptors.get(directory).flags).toBe(NONBLOCK);
      const fd = fs.open(`/proc/self/fd/${directory}/source.txt`, readFlags);
      expect(fs.descriptors.get(fd).closeOnExec).toBe(true);
      expect(fs.descriptors.get(fd).flags).toBe(NONBLOCK);
      const content = new Uint8Array(12);
      expect(fs.read(fd, content, null)).toBe(12);
      expect(new TextDecoder().decode(content)).toBe("source bytes");
      expect(() => fs.write(fd, bytes("blocked"), 0n)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(() => fs.open(`/proc/self/fd/${directory}/new.txt`, readFlags)).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      fs.symlink("source.txt", "/work/link.txt");
      expect(() => fs.open(`/proc/self/fd/${directory}/link.txt`, readFlags)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
      expect(() => fs.open(`/proc/self/fd/${directory}`, readFlags)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
      fs.close(directory);
      expect(() => fs.open(`/proc/self/fd/${directory}/source.txt`, readFlags)).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      test.close();
    }
  });

  it("keeps directory, read-only mount and unsupported-flag restrictions", () => {
    const test = createFixture();
    const fs = test.filesystem;
    const readOnly = new KernelFileSystem({
      mounts: [{ path: "/", storage: test.storage, readOnly: true }],
    });
    try {
      const fd = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      fs.close(fd);
      fs.mkdir("/directory");
      expect(() =>
        fs.open("/file", KernelOpenFlags.O_NONBLOCK | KernelOpenFlags.O_DIRECTORY),
      ).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
      expect(() =>
        fs.open("/directory", KernelOpenFlags.O_NONBLOCK | KernelOpenFlags.O_WRONLY),
      ).toThrow(expect.objectContaining({ code: "EISDIR" }));
      expect(() =>
        readOnly.open("/file", KernelOpenFlags.O_NONBLOCK | KernelOpenFlags.O_WRONLY),
      ).toThrow(expect.objectContaining({ code: "EROFS" }));
      expect(() => fs.open("/file", KernelOpenFlags.O_NONBLOCK | KernelOpenFlags.O_ASYNC)).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
    } finally {
      readOnly.dispose();
      test.close();
    }
  });

  it("keeps stream and virtual-device nonblocking opens unsupported", () => {
    const test = createFixture();
    try {
      for (const path of ["/dev/null", "/dev/zero", "/dev/random", "/proc/self/fd/0"]) {
        expect(() => test.filesystem.open(path, KernelOpenFlags.O_NONBLOCK)).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
      }
    } finally {
      test.close();
    }
  });

  it("continues to ignore status flags on metadata-only O_PATH descriptors", () => {
    const test = createFixture();
    const fs = test.filesystem;
    try {
      const file = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      fs.close(file);
      const path = fs.open("/file", KernelOpenFlags.O_PATH | KernelOpenFlags.O_NONBLOCK);
      expect(fs.descriptors.get(path).flags).toBe(0);
      expect(() => fs.read(path, new Uint8Array(1), null)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
    } finally {
      test.close();
    }
  });
});
