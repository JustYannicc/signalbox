import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { WASI } from "./Wasi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const cleanups: (() => void)[] = [];
const encoder = new TextEncoder();
const PATH = 64;
const OUTPUT = 8192;
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).toReversed()) close();
});

function fixture() {
  const database = sqliteFixture();
  cleanups.push(database.close);
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const directory = storage.create(storage.root, "dir", { type: "directory", exclusive: true });
  const file = storage.create(directory, "file", { type: "file", exclusive: true });
  function runner(name: string, params: readonly ("i32" | "i64")[]) {
    const wasi = new WASI({ version: "preview1", mounts: [{ path: "/", storage }] });
    cleanups.push(() => wasi.close());
    const instance = new WebAssembly.Instance(
      wasmImportReactor("wasi_snapshot_preview1", name, params, ["i32"]),
      wasi.getImportObject(),
    );
    wasi.initialize(instance);
    const { memory, run } = instance.exports;
    if (!(memory instanceof WebAssembly.Memory) || typeof run !== "function") {
      throw new Error("Missing WASI reactor exports");
    }
    return {
      memory: new DataView(memory.buffer),
      writePath(path: string) {
        const bytes = encoder.encode(path);
        new Uint8Array(memory.buffer, PATH, bytes.length).set(bytes);
        return bytes.length;
      },
      call(...args: Array<number | bigint>) {
        const result: unknown = run(...args);
        if (typeof result !== "number") throw new Error("Missing WASI errno");
        return result;
      },
    };
  }
  const stat = runner("path_filestat_get", ["i32", "i32", "i32", "i32", "i32"]);
  return {
    storage,
    directory,
    file,
    runner,
    stat(path: string, follow = true) {
      return stat.call(3, follow ? 1 : 0, PATH, stat.writePath(path), OUTPUT);
    },
    inode: () => stat.memory.getBigUint64(OUTPUT + 8, true),
    createDirectory(path: string) {
      const create = runner("path_create_directory", ["i32", "i32", "i32"]);
      return create.call(3, PATH, create.writePath(path));
    },
  };
}

describe("WASI path resolution through guest imports", () => {
  it("validates guest paths without allocating UTF-8 output buffers", () => {
    const test = fixture();
    const stat = test.runner("path_filestat_get", ["i32", "i32", "i32", "i32", "i32"]);
    for (const [path, expected] of [
      ["dir/file", 0],
      ["é".repeat(2049), 37],
    ] as const) {
      const length = stat.writePath(path);
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      expect(stat.call(3, 1, PATH, length, OUTPUT)).toBe(expected);
      expect(encode).not.toHaveBeenCalled();
      encode.mockRestore();
    }
  });

  it.each(["dir/file", "dir//file", "dir/./file", "dir/../dir/file"])(
    "resolves %s from the preopen root on repeated calls",
    (path) => {
      const test = fixture();
      expect(test.stat(path)).toBe(0);
      expect(test.inode()).toBe(test.file);
      expect(test.stat("dir/file")).toBe(0);
      expect(test.inode()).toBe(test.file);
    },
  );

  it.each(["dir/new", "dir//new///", "dir/./new", "dir/../dir/new/"])(
    "creates %s through its confined parent",
    (path) => {
      const test = fixture();
      expect(test.createDirectory(path)).toBe(0);
      expect(test.stat("dir/new/")).toBe(0);
      expect(test.storage.lookup(test.directory, "new")).toBe(test.inode());
      expect(test.createDirectory("root-new///")).toBe(0);
      expect(test.stat("root-new/")).toBe(0);
    },
  );

  it("preserves missing-leaf, trailing slash and invalid-parent errnos", () => {
    const test = fixture();
    const open = test.runner("path_open", [
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
    const createFile = (path: string) =>
      open.call(3, 1, PATH, open.writePath(path), 1, 0n, 0n, 0, OUTPUT);
    expect(createFile("dir/new")).toBe(0);
    expect(test.stat("dir/new")).toBe(0);
    expect(createFile("dir/missing/")).toBe(44);
    expect(createFile("dir/missing/new")).toBe(44);
    expect(test.stat("dir/file/")).toBe(54);
    for (const path of ["dir/.", "dir/..", ".", ".."]) {
      expect(test.createDirectory(path)).toBe(28);
    }
  });

  it("follows symlinks before dot-dot and confines absolute targets to the mount", () => {
    const test = fixture();
    test.storage.create(test.directory, "nested", { type: "directory", exclusive: true });
    test.storage.create(test.storage.root, "link", {
      type: "symlink",
      exclusive: true,
      target: "dir/nested",
    });
    const absolute = test.storage.create(test.directory, "absolute", {
      type: "symlink",
      exclusive: true,
      target: "/dir/file",
    });
    expect(test.stat("link/../file")).toBe(0);
    expect(test.inode()).toBe(test.file);
    expect(test.stat("dir/absolute")).toBe(0);
    expect(test.inode()).toBe(test.file);
    expect(test.stat("dir/absolute", false)).toBe(0);
    expect(test.inode()).toBe(absolute);
    expect(test.createDirectory("link/../new")).toBe(0);
    expect(test.stat("dir/new")).toBe(0);
    expect(test.stat("../dir")).toBe(76);
  });

  it.each([
    ["a", 4096],
    ["é", 2048],
    ["€", 1365],
    ["🎉", 1024],
  ])("keeps the UTF-8 path limit for %j", (character, count) => {
    const test = fixture();
    const name = character.repeat(count);
    const file = test.storage.create(test.storage.root, name, { type: "file", exclusive: true });
    expect(test.stat(name)).toBe(0);
    expect(test.inode()).toBe(file);
    const overlong = name + "xxxx";
    expect(test.stat(overlong)).toBe(37);
    expect(test.createDirectory(overlong)).toBe(37);
    expect(test.stat(`/${overlong}`)).toBe(76);
    expect(test.stat(`${overlong}\0`)).toBe(28);
  });

  it("counts lone surrogates in storage symlink targets as replacement bytes", () => {
    const test = fixture();
    const target = "\ud800".repeat(1365);
    const file = test.storage.create(test.storage.root, target, { type: "file", exclusive: true });
    test.storage.create(test.storage.root, "valid", { type: "symlink", exclusive: true, target });
    test.storage.create(test.storage.root, "overlong", {
      type: "symlink",
      exclusive: true,
      target: target + "xx",
    });
    expect(test.stat("valid")).toBe(0);
    expect(test.inode()).toBe(file);
    expect(test.stat("overlong")).toBe(37);
  });
});
