import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { createAgentOsHostFsArgumentTransform, resolveHiddenPreopenFd } from "./AgentOsWasi.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { AgentOsFileSystemHost } from "./AgentOsFileSystemHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const U64_MAX = (1n << 64n) - 1n;
const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();

function fixture(agentOsPreopens = false) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, now);
  const fileSystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = new AgentOsFileSystemHost({ memory: () => memory, fileSystem, agentOsPreopens });

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

  it("maps only tagged path-directory operands when the preopen adapter is enabled", () => {
    const test = fixture(true);
    try {
      const preopenFd = [...test.fileSystem.descriptors.entries()].find(
        ([, descriptor]) => descriptor.preopen === true,
      )?.[0];
      if (preopenFd === undefined) throw new Error("Root preopen is missing");
      const taggedPreopen = 0x4000_0000 | preopenFd;
      const filePathLength = test.writePath(64, "work/file");
      const linkPathLength = test.writePath(96, "published");
      const directoryPathLength = test.writePath(160, "work");
      const transform = createAgentOsHostFsArgumentTransform(test.fileSystem);

      expect(resolveHiddenPreopenFd(taggedPreopen, test.fileSystem)).toBe(preopenFd);
      expect(test.host.imports.path_size(taggedPreopen, 64, filePathLength, 1)).toBe(5n);
      expect(test.host.imports.path_owner(taggedPreopen, 64, filePathLength, 1, 128, 132)).toBe(58);
      expect(test.host.imports.path_access(taggedPreopen, 64, filePathLength, 4, 0)).toBe(58);
      expect(
        test.host.imports.open_tmpfile(taggedPreopen, 160, directoryPathLength, 0, 0o600, 136),
      ).toBe(58);
      expect(test.host.imports.fd_link(test.fileFd, taggedPreopen, 96, linkPathLength)).toBe(58);

      const taggedFile = 0x4000_0000 | test.fileFd;
      expect(test.host.imports.fd_size(taggedFile)).toBe(U64_MAX);
      expect(test.host.imports.ftruncate(taggedFile, 2n)).toBe(8);
      expect(test.host.imports.fd_link(taggedFile, taggedPreopen, 96, linkPathLength)).toBe(8);
      expect(
        test.host.imports.path_owner(0x8000_0000 | preopenFd, 64, filePathLength, 1, 128, 132),
      ).toBe(8);
      expect(
        test.host.imports.path_owner(0x4000_0000 | 0x3fff_ffff, 64, filePathLength, 1, 128, 132),
      ).toBe(8);

      const positions: Readonly<Record<string, readonly number[]>> = {
        fd_link: [1],
        open_tmpfile: [0],
        path_access: [0],
        path_blocks: [0],
        path_mode: [0],
        path_owner: [0],
        path_size: [0],
      };
      for (const [name, indexes] of Object.entries(positions)) {
        const args = Array<number>(6).fill(12);
        for (const index of indexes) args[index] = taggedPreopen;
        const expected = [...args];
        for (const index of indexes) expected[index] = preopenFd;
        expect(transform(name, args), name).toEqual(expected);
      }
      const untouchedFdLinkSource = transform("fd_link", [
        taggedFile,
        taggedPreopen,
        96,
        linkPathLength,
      ]);
      expect(untouchedFdLinkSource).toEqual([taggedFile, preopenFd, 96, linkPathLength]);
      const ordinaryMutation = [taggedFile, 2n] as const;
      expect(transform("ftruncate", ordinaryMutation)).toBe(ordinaryMutation);
    } finally {
      test.close();
    }
  });

  it("keeps the adapter opt-in and exercises translated host_fs operands in WASM", () => {
    const enabled = fixture(true);
    const disabled = fixture();
    const enabledSize = hostFsWasmRunner(
      enabled.fileSystem,
      "path_size",
      ["i32", "i32", "i32", "i32"],
      ["i64"],
      true,
    );
    const disabledOwner = hostFsWasmRunner(
      disabled.fileSystem,
      "path_owner",
      ["i32", "i32", "i32", "i32", "i32", "i32"],
      ["i32"],
      false,
    );

    try {
      const enabledPreopen = [...enabled.fileSystem.descriptors.entries()].find(
        ([, descriptor]) => descriptor.preopen === true,
      )?.[0];
      const disabledPreopen = [...disabled.fileSystem.descriptors.entries()].find(
        ([, descriptor]) => descriptor.preopen === true,
      )?.[0];
      if (enabledPreopen === undefined || disabledPreopen === undefined) {
        throw new Error("Root preopen is missing");
      }

      const enabledLength = writePath(enabledSize.memory, 64, "work/file");
      expect(enabledSize.run(0x4000_0000 | enabledPreopen, 64, enabledLength, 1)).toBe(5n);
      const disabledLength = writePath(disabledOwner.memory, 64, "work/file");
      expect(
        disabledOwner.run(0x4000_0000 | disabledPreopen, 64, disabledLength, 1, 128, 132),
      ).toBe(8);
    } finally {
      enabled.close();
      disabled.close();
    }
  });
});

function hostFsWasmRunner(
  fileSystem: KernelFileSystem,
  importName: string,
  params: readonly ("i32" | "i64")[],
  results: readonly ("i32" | "i64")[],
  agentOsPreopens: boolean,
) {
  let instance: WebAssembly.Instance | undefined;
  const host = new AgentOsFileSystemHost({
    memory: () => {
      const memory = instance?.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory is missing");
      return memory;
    },
    fileSystem,
    agentOsPreopens,
  });
  const hostFsImports: Record<string, WebAssembly.ImportValue> = {};
  if (importName === "path_size") hostFsImports.path_size = host.imports.path_size;
  else if (importName === "path_owner") hostFsImports.path_owner = host.imports.path_owner;
  else throw new Error(`Unsupported host_fs test import: ${importName}`);
  instance = new WebAssembly.Instance(wasmImportReactor("host_fs", importName, params, results), {
    host_fs: hostFsImports,
  });
  const memory = instance.exports.memory as WebAssembly.Memory;
  const run = instance.exports.run as (...args: Array<number | bigint>) => number | bigint;
  return { memory, run: (...args: Array<number | bigint>) => run(...args) };
}

function writePath(memory: WebAssembly.Memory, pointer: number, path: string): number {
  const bytes = encoder.encode(path);
  new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
  return bytes.byteLength;
}
