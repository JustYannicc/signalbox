import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { AgentOsFileSystemHost } from "./AgentOsFileSystemHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const U64_MAX = (1n << 64n) - 1n;
const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();

function fixture() {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, now);
  const fileSystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = new AgentOsFileSystemHost({ memory: () => memory, fileSystem });

  fileSystem.mkdir("/work");
  const directoryFd = fileSystem.open(
    "/work",
    KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
  );
  const fileFd = fileSystem.open("/work/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
  fileSystem.write(fileFd, encoder.encode("hello"), 0n);
  fileSystem.symlink("file", "/work/link");

  const writePath = (pointer: number, path: string) => {
    const bytes = encoder.encode(path);
    new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
    return bytes.byteLength;
  };

  return {
    memory,
    host,
    fileSystem,
    directoryFd,
    fileFd,
    writePath,
    close() {
      fileSystem.dispose();
      database.close();
    },
  };
}

describe("AgentOS host_fs imports", () => {
  it("exposes the pinned import surface and uses KernelFileSystem for size and truncation", () => {
    const test = fixture();
    try {
      const names = [
        "set_open_mode",
        "fd_mode",
        "path_mode",
        "fd_size",
        "fd_blocks",
        "fd_owner",
        "ftruncate",
        "open_tmpfile",
        "set_open_direct",
        "path_access",
        "path_size",
        "path_blocks",
        "path_owner",
        "fd_link",
        "fchmod",
      ].sort();
      expect(Object.keys(test.host.imports).sort()).toEqual(names);
      expect(Object.keys(test.host.getImportObject().host_fs).sort()).toEqual(names);
      expect(test.host.suspendingImports).toEqual([]);

      const linkLength = test.writePath(64, "link");
      expect(test.host.imports.fd_size(test.fileFd)).toBe(5n);
      expect(test.host.imports.path_size(test.directoryFd, 64, linkLength, 0)).toBe(4n);
      expect(test.host.imports.path_size(test.directoryFd, 64, linkLength, 1)).toBe(5n);
      expect(test.host.imports.ftruncate(test.fileFd, 2n)).toBe(0);
      expect(test.host.imports.fd_size(test.fileFd)).toBe(2n);
      expect(test.host.imports.path_size(test.directoryFd, 64, linkLength, 1)).toBe(2n);

      expect(test.host.imports.fd_size(999)).toBe(U64_MAX);
      expect(test.host.imports.path_size(test.directoryFd, 65_534, 8, 1)).toBe(U64_MAX);
      expect(test.host.imports.ftruncate(999, 2n)).toBe(8);
    } finally {
      test.close();
    }
  });

  it("uses declared unavailable sentinels and returns ENOTSUP without changing guest or filesystem state", () => {
    const test = fixture();
    try {
      const filePathLength = test.writePath(64, "file");
      const linkPathLength = test.writePath(96, "published");
      const directoryPathLength = test.writePath(160, ".");
      new Uint8Array(test.memory.buffer, 128, 12).fill(0x7f);
      const before = [...new Uint8Array(test.memory.buffer, 128, 12)];

      expect(test.host.imports.fd_mode(test.fileFd)).toBe(0);
      expect(test.host.imports.path_mode(test.directoryFd, 64, filePathLength, 1)).toBe(0);
      expect(test.host.imports.path_mode(test.directoryFd, 65_534, 8, 1)).toBe(0);
      expect(test.host.imports.fd_blocks(test.fileFd)).toBe(U64_MAX);
      expect(test.host.imports.path_blocks(test.directoryFd, 64, filePathLength, 1)).toBe(U64_MAX);

      expect(test.host.imports.fd_owner(test.fileFd, 128, 132)).toBe(58);
      expect(test.host.imports.path_owner(test.directoryFd, 64, filePathLength, 1, 128, 132)).toBe(
        58,
      );
      expect(test.host.imports.path_access(test.directoryFd, 64, filePathLength, 4, 0)).toBe(58);
      expect(test.host.imports.fchmod(test.fileFd, 0o600)).toBe(58);
      expect(test.host.imports.set_open_mode(0o600)).toBe(58);
      expect(test.host.imports.set_open_direct(1)).toBe(58);
      expect(
        test.host.imports.open_tmpfile(test.directoryFd, 160, directoryPathLength, 0, 0o600, 136),
      ).toBe(58);
      expect(test.host.imports.fd_link(test.fileFd, test.directoryFd, 96, linkPathLength)).toBe(58);

      expect([...new Uint8Array(test.memory.buffer, 128, 12)]).toEqual(before);
      expect(test.fileSystem.fstat(test.fileFd).size).toBe(5n);
      expect(() => test.fileSystem.stat("/work/published")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      test.close();
    }
  });

  it("checks every guest pointer before filesystem lookup or output writes", () => {
    const test = fixture();
    try {
      expect(test.host.imports.fd_owner(999, 65_535, 0)).toBe(21);
      expect(test.host.imports.path_owner(999, 65_534, 8, 1, 128, 132)).toBe(21);
      expect(test.host.imports.open_tmpfile(999, 65_534, 8, 0, 0, 65_535)).toBe(21);
      expect(test.host.imports.path_access(test.directoryFd, 65_534, 8, 0, 0)).toBe(21);
      expect(test.host.imports.path_access(test.directoryFd, 64, 4, 8, 0)).toBe(28);
    } finally {
      test.close();
    }
  });

  it("resolves relative paths from a live directory descriptor after its path is replaced", () => {
    const test = fixture();
    try {
      test.fileSystem.mkdir("/old");
      const oldDirectoryFd = test.fileSystem.open(
        "/old",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      const originalFileFd = test.fileSystem.open(
        "/old/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      test.fileSystem.write(originalFileFd, encoder.encode("12345"), 0n);
      test.fileSystem.close(originalFileFd);

      test.fileSystem.rename("/old", "/new");
      test.fileSystem.mkdir("/old");
      const replacementFileFd = test.fileSystem.open(
        "/old/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      test.fileSystem.write(replacementFileFd, encoder.encode("123456789"), 0n);

      const pathLength = test.writePath(256, "file");
      const openDescriptors = [...test.fileSystem.descriptors.entries()].map(([fd]) => fd);
      expect(test.host.imports.path_size(oldDirectoryFd, 256, pathLength, 1)).toBe(5n);
      expect(test.host.imports.fd_size(replacementFileFd)).toBe(9n);
      expect([...test.fileSystem.descriptors.entries()].map(([fd]) => fd)).toEqual(openDescriptors);
    } finally {
      test.close();
    }
  });
});
