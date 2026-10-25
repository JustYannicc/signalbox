import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { createKernelNimbusMetadata } from "./KernelNimbusMetadata.ts";

const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000, groups: [2000] };

function setup(policy = true) {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: [
      { readInto: () => 0 },
      { write: (bytes) => bytes.length },
      { write: (bytes) => bytes.length },
    ],
    ...(policy ? { posix: { credentials, umask: 0o022 } } : {}),
  });
  filesystem.mkdir("/workspace");
  filesystem.chdir("/workspace");
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelNimbusMetadata({ memory: () => memory, filesystem });
  const path = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    new Uint8Array(memory.buffer).set(bytes, 64);
    return [64, bytes.length] as const;
  };
  return {
    filesystem,
    storage,
    memory,
    imports,
    path,
    close: () => {
      filesystem.dispose();
      fixture.close();
    },
  };
}

function words(memory: WebAssembly.Memory) {
  const view = new DataView(memory.buffer);
  return [view.getUint32(256, true), view.getUint32(260, true), view.getUint32(264, true)];
}

describe("Nimbus POSIX metadata", () => {
  it("marshals persisted mode and owners into exactly three little-endian words", () => {
    const context = setup();
    try {
      const fd = context.filesystem.open(
        "file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
        0o640,
      );
      expect(context.imports.stat_metadata(fd, 0, 0, 1, 256)).toBe(0);
      expect(words(context.memory)).toEqual([0o100640, 1000, 1000]);
      const directory = context.path("/workspace");
      expect(context.imports.stat_metadata(-1, ...directory, 1, 256)).toBe(0);
      expect(words(context.memory)).toEqual([0o040755, 1000, 1000]);
      context.filesystem.close(fd);
    } finally {
      context.close();
    }
  });

  it("uses the held dirfd anchor after its original pathname is renamed", () => {
    const context = setup();
    try {
      context.filesystem.mkdir("/workspace/held");
      const directory = context.filesystem.open(
        "/workspace/held",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      const file = context.filesystem.open(
        "/workspace/held/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o600,
      );
      context.filesystem.close(file);
      context.filesystem.rename("/workspace/held", "/workspace/moved");
      context.filesystem.mkdir("/workspace/held");
      const replacement = context.filesystem.open(
        "/workspace/held/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o644,
      );
      context.filesystem.close(replacement);
      expect(context.imports.stat_metadata(directory, ...context.path("file"), 1, 256)).toBe(0);
      expect(words(context.memory)).toEqual([0o100600, 1000, 1000]);
      context.filesystem.close(directory);
    } finally {
      context.close();
    }
  });

  it("validates output memory before descriptor lookup and refuses unknown metadata", () => {
    const context = setup(false);
    try {
      const fd = context.filesystem.open(
        "legacy",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      expect(
        context.imports.stat_metadata(99999, 0, 0, 1, context.memory.buffer.byteLength - 8),
      ).toBe(21);
      expect(context.imports.stat_metadata(fd, 0, 0, 1, 256)).toBe(58);
      expect(context.imports.stat_metadata(0, 0, 0, 1, 256)).toBe(8);
      expect(context.imports.fchmod(0, 0o600)).toBe(8);
      expect(context.imports.chown(0, 0, 0, -1, -1, 1)).toBe(8);
      context.filesystem.close(fd);
    } finally {
      context.close();
    }
  });

  it("changes canonical permissions and preserves the owner sentinel on chown", () => {
    const context = setup();
    try {
      const fd = context.filesystem.open(
        "file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
        0o600,
      );
      expect(context.imports.chmod(...context.path("file"), 0o100640)).toBe(0);
      expect(context.filesystem.getPosixMetadata("file").mode).toBe(0o640);
      expect(context.imports.fchmod(fd, 0o100660)).toBe(0);
      expect(context.imports.chown(fd, 0, 0, -1, 2000, 1)).toBe(0);
      expect(context.filesystem.getPosixMetadataForFd(fd)).toEqual({
        mode: 0o660,
        uid: 1000,
        gid: 2000,
      });
      expect(context.imports.chown(fd, 0, 0, 3000, -1, 1)).toBe(63);
      expect(context.filesystem.getPosixMetadataForFd(fd)).toEqual({
        mode: 0o660,
        uid: 1000,
        gid: 2000,
      });
      context.filesystem.close(fd);
    } finally {
      context.close();
    }
  });

  it("refuses metadata credentials that differ from the filesystem policy", () => {
    const context = setup();
    try {
      expect(() =>
        createKernelNimbusMetadata({
          memory: () => context.memory,
          filesystem: context.filesystem,
          credentials: { ...credentials, euid: 2000 },
        }),
      ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    } finally {
      context.close();
    }
  });

  it("keeps no-follow owner changes on the symlink inode", () => {
    const context = setup();
    try {
      const fd = context.filesystem.open(
        "file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
        0o600,
      );
      context.filesystem.close(fd);
      context.filesystem.symlink("file", "link");
      expect(context.imports.chown(-1, ...context.path("link"), -1, 2000, 0)).toBe(0);
      expect(context.filesystem.getPosixMetadata("link", false)).toEqual({
        mode: 0o777,
        uid: 1000,
        gid: 2000,
      });
      expect(context.filesystem.getPosixMetadata("file")).toEqual({
        mode: 0o600,
        uid: 1000,
        gid: 1000,
      });
      expect(context.imports.stat_metadata(-1, ...context.path("link"), 0, 256)).toBe(0);
      expect(words(context.memory)).toEqual([0o120777, 1000, 2000]);
    } finally {
      context.close();
    }
  });
});
