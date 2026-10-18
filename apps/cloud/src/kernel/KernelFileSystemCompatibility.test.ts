import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const now = () => 1_800_000_000_000_000_001n;
const bytes = (text: string) => new TextEncoder().encode(text);

describe("KernelFileSystem compatibility", () => {
  it("routes a relative path into the mounted filesystem instead of a hidden parent entry", () => {
    const rootFixture = sqliteFixture();
    const mountedFixture = sqliteFixture();
    const rootStorage = createFacetSqliteStorage(rootFixture.storage, now);
    const mountedStorage = createFacetSqliteStorage(mountedFixture.storage, now);
    const setup = new KernelFileSystem({ mounts: [{ path: "/", storage: rootStorage }] });
    setup.mkdir("/m");
    const hiddenFd = setup.open("/m/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
    setup.write(hiddenFd, bytes("hidden"), 0n);
    setup.close(hiddenFd);
    setup.symlink("/m", "/shortcut");
    setup.dispose();

    const mountedRoot = mountedStorage.root;
    const mountedFile = mountedStorage.create(mountedRoot, "file", {
      type: "file",
      exclusive: true,
    });
    mountedStorage.write(mountedFile, 0n, bytes("mounted"));
    mountedStorage.release(mountedFile);

    const fileSystem = new KernelFileSystem({
      mounts: [
        { path: "/", storage: rootStorage },
        { path: "/m", storage: mountedStorage, readOnly: true },
      ],
    });
    try {
      const fd = fileSystem.open("m/file", KernelOpenFlags.O_RDONLY);
      const actual = new Uint8Array(7);
      expect(fileSystem.read(fd, actual, 0n)).toBe(7);
      expect(new TextDecoder().decode(actual)).toBe("mounted");
      expect(fileSystem.resolve("m/file").mount.path).toBe("/m");
      expect(() => fileSystem.resolve("shortcut/file")).toThrow(
        expect.objectContaining({ code: "ENOTCAPABLE" }),
      );
      fileSystem.close(fd);
    } finally {
      fileSystem.dispose();
      rootFixture.close();
      mountedFixture.close();
    }
  });

  it("does not grant readdir through an O_PATH directory and gives write-only files seek rights", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fileSystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    fileSystem.mkdir("/work");
    const pathDirectory = fileSystem.open(
      "/work",
      KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY,
    );
    const file = fileSystem.open("/work/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);

    try {
      const directoryWakes = new KernelWakeRegistry();
      const directoryHost = createKernelAsyncWasi({
        filesystem: fileSystem,
        wakes: directoryWakes,
      });
      const readDirectory = await createImportRunner(directoryHost, "fd_readdir", [
        "i32",
        "i32",
        "i32",
        "i64",
        "i32",
      ]);
      try {
        expect(await readDirectory.run(pathDirectory, 64, 16, 0n, 128)).toBe(76);
      } finally {
        await readDirectory.close();
        directoryWakes.dispose();
      }

      const seekWakes = new KernelWakeRegistry();
      const seekHost = createKernelAsyncWasi({ filesystem: fileSystem, wakes: seekWakes });
      const seek = await createImportRunner(seekHost, "fd_seek", ["i32", "i64", "i32", "i32"]);
      try {
        expect(await seek.run(file, 0n, 0, 128)).toBe(0);
        expect(new DataView(seek.memory.buffer).getBigUint64(128, true)).toBe(0n);
      } finally {
        await seek.close();
        seekWakes.dispose();
      }
    } finally {
      fileSystem.dispose();
      fixture.close();
    }
  });

  it("lets an O_RDONLY directory open a writable child file through WASI", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fileSystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    fileSystem.mkdir("/work");
    const file = fileSystem.open("/work/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
    fileSystem.close(file);
    const directory = fileSystem.open(
      "/work",
      KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
    );
    const wakes = new KernelWakeRegistry();
    const host = createKernelAsyncWasi({ filesystem: fileSystem, wakes });
    const open = await createImportRunner(host, "path_open", [
      "i32",
      "i32",
      "i32",
      "i32",
      "i32",
      "i64",
      "i64",
      "i32",
      "i32",
    ]);

    try {
      new Uint8Array(open.memory.buffer, 64, 4).set(bytes("file"));
      expect(await open.run(directory, 0, 64, 4, 0, 1n << 6n, 0n, 0, 128)).toBe(0);
      expect(new DataView(open.memory.buffer).getUint32(128, true)).toBeGreaterThanOrEqual(3);
    } finally {
      await open.close();
      wakes.dispose();
      fileSystem.dispose();
      fixture.close();
    }
  });

  it("preserves the stdio callback receiver for reads, writes, and sync", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const input = {
      value: 65,
      reads: 0,
      readInto(target: Uint8Array) {
        this.reads++;
        target[0] = this.value;
        return 1;
      },
    };
    const output = {
      value: "",
      syncs: 0,
      write(source: Uint8Array) {
        this.value += new TextDecoder().decode(source);
        return source.byteLength;
      },
      sync() {
        this.syncs++;
      },
    };
    const fileSystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      stdio: [input, output, output],
    });
    try {
      const received = new Uint8Array(1);
      expect(fileSystem.read(0, received, null)).toBe(1);
      expect(received[0]).toBe(65);
      expect(input.reads).toBe(1);

      expect(fileSystem.write(1, bytes("out"), null)).toBe(3);
      fileSystem.sync(1);
      expect(output.value).toBe("out");
      expect(output.syncs).toBe(1);
    } finally {
      fileSystem.dispose();
      fixture.close();
    }
  });
});

async function createImportRunner(
  host: ReturnType<typeof createKernelAsyncWasi>,
  importName: string,
  params: readonly ("i32" | "i64")[],
) {
  const module = wasmImportReactor("wasi_snapshot_preview1", importName, params, ["i32"]);
  const instance = new WebAssembly.Instance(module, host.wasi.getImportObject());
  await host.wasi.initialize(instance);
  const run = instance.exports.run as (...args: Array<number | bigint>) => unknown;
  const memory = instance.exports.memory as WebAssembly.Memory;
  return {
    memory,
    run: (...args: Array<number | bigint>) => host.wasi.run(run, ...args) as Promise<number>,
    close: () => host.wasi.close(),
  };
}
