import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const bytes = (text: string) => new TextEncoder().encode(text);
const decoder = new TextDecoder();

function writeFile(fs: KernelFileSystem, path: string, content: string): void {
  const fd = fs.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
  try {
    fs.write(fd, bytes(content), 0n);
  } finally {
    fs.close(fd);
  }
}

function readFile(fs: KernelFileSystem, path: string): string {
  const fd = fs.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const content = new Uint8Array(Number(fs.fstat(fd).size));
    fs.read(fd, content, null);
    return decoder.decode(content);
  } finally {
    fs.close(fd);
  }
}

describe("KernelFileSystem descriptor-relative paths", () => {
  it("reads, creates, stats, renames, and unlinks through procfd and devfd suffixes", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      fs.mkdir("/work");
      const directoryFd = fs.open("/work", KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY);
      const proc = `/proc/self/fd/${directoryFd}`;
      const dev = `/dev/fd/${directoryFd}`;
      const source = `${proc}/source`;
      const createdFd = fs.open(source, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
      fs.write(createdFd, bytes("descriptor data"), 0n);
      fs.close(createdFd);

      expect(fs.stat(`${dev}/source`)).toMatchObject({ type: "file", size: 15n });
      expect(readFile(fs, `${dev}/source`)).toBe("descriptor data");
      expect(() => fs.stat(`${proc}/source/`)).toThrow(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
      expect(fs.stat(`${proc}/`)).toMatchObject({
        type: "directory",
        ino: fs.fstat(directoryFd).ino,
      });

      const renamed = `${dev}/renamed`;
      fs.rename(source, renamed);
      expect(fs.stat(`${proc}/renamed`).size).toBe(15n);
      fs.unlink(`${proc}/renamed`);
      expect(() => fs.stat(`${dev}/renamed`)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("keeps symlink traversal ahead of dot-dot and applies nofollow to the leaf", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      fs.mkdir("/work");
      fs.mkdir("/work/actual");
      fs.mkdir("/work/actual/nested");
      writeFile(fs, "/work/actual/wanted", "symlink traversal");
      writeFile(fs, "/work/wanted", "lexical normalization");
      fs.symlink("actual/nested", "/work/link");
      const directoryFd = fs.open("/work", KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY);
      const through = `/proc/self/fd/${directoryFd}`;

      expect(readFile(fs, `${through}/link/../wanted`)).toBe("symlink traversal");
      expect(fs.realpath(`${through}/link/../wanted`)).toBe("/work/actual/wanted");
      expect(() =>
        fs.open(`${through}/link`, KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_NOFOLLOW),
      ).toThrow(expect.objectContaining({ code: "ELOOP" }));

      const nofollowFd = fs.open(
        `${through}/link`,
        KernelOpenFlags.O_PATH | KernelOpenFlags.O_NOFOLLOW,
      );
      expect(fs.fstat(nofollowFd).type).toBe("symlink");
      fs.close(nofollowFd);
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("refreshes same-parent renames and rejects stale, closed, and non-directory anchors", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      fs.mkdir("/parent");
      fs.mkdir("/parent/old");
      writeFile(fs, "/parent/old/child", "same parent");
      const renamedFd = fs.open(
        "/parent/old",
        KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY,
      );
      fs.rename("/parent/old", "/parent/new");
      expect(fs.realpath(`/proc/self/fd/${renamedFd}/child`)).toBe("/parent/new/child");

      fs.mkdir("/before");
      fs.mkdir("/after");
      fs.mkdir("/before/work");
      writeFile(fs, "/before/work/child", "stale");
      const staleFd = fs.open("/before/work", KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY);
      fs.rename("/before/work", "/after/work");
      expect(() => fs.stat(`/proc/self/fd/${staleFd}/child`)).toThrow(
        expect.objectContaining({ code: "ESTALE" }),
      );

      const closedFd = fs.open("/parent/new", KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY);
      fs.close(closedFd);
      expect(() => fs.stat(`/proc/self/fd/${closedFd}/child`)).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );

      const fileFd = fs.open("/parent/new/child", KernelOpenFlags.O_PATH);
      expect(() => fs.stat(`/proc/self/fd/${fileFd}/child`)).toThrow(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("keeps descriptor suffixes inside the directory capability and mount", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const setup = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      setup.mkdir("/shadow");
      const fs = new KernelFileSystem({
        mounts: [
          { path: "/", storage },
          { path: "/shadow", storage },
        ],
      });
      try {
        writeFile(fs, "/ordinary", "root mount");
        const rootFd = fs.open("/", KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY);
        expect(fs.stat(`/proc/self/fd/${rootFd}/ordinary`).type).toBe("file");
        expect(() => fs.stat(`/proc/self/fd/${rootFd}/shadow/ordinary`)).toThrow(
          expect.objectContaining({ code: "ENOTCAPABLE" }),
        );
        expect(() => fs.stat(`/proc/self/fd/${rootFd}/../ordinary`)).toThrow(
          expect.objectContaining({ code: "ENOTCAPABLE" }),
        );
      } finally {
        fs.dispose();
      }
    } finally {
      setup.dispose();
      fixture.close();
    }
  });
});
