import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { sqliteFixture } from "../tests/sqliteFixture.ts";
import { complete, runSync } from "./internal_wasi_calls.ts";
import { normalizeMounts, WasiPathResolver } from "./internal_wasi_paths.ts";

const databases: ReturnType<typeof sqliteFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = sqliteFixture();
  databases.push(database);
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const mount = normalizeMounts([{ path: "/", storage }])[0]!;
  const base = { mount, inode: storage.root, ancestors: [storage.root], pathComponents: [] };
  const resolver = new WasiPathResolver(complete);
  const directory = storage.create(storage.root, "dir", { type: "directory", exclusive: true });
  const file = storage.create(directory, "file", { type: "file", exclusive: true });
  return { storage, base, resolver, directory, file };
}

const errno = (value: number) => expect.objectContaining({ errno: value });

describe("WASI path resolution", () => {
  it("validates paths without allocating UTF-8 output buffers", () => {
    const { base, resolver } = fixture();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    expect(runSync(resolver.resolve(base, "dir/file", true)).stat.type).toBe("file");
    expect(() => runSync(resolver.resolve(base, "é".repeat(2049), true))).toThrow(errno(37));
    expect(encode).not.toHaveBeenCalled();
  });
  it.each(["dir/file", "dir//file", "dir/./file", "dir/../dir/file"])(
    "resolves %s without changing the anchor",
    (path) => {
      const { base, resolver, directory, file } = fixture();
      expect(runSync(resolver.resolve(base, path, true))).toMatchObject({
        inode: file,
        parent: directory,
        name: "file",
        pathComponents: ["dir", "file"],
        ancestors: [base.inode, directory],
      });
      expect(base.ancestors).toEqual([base.inode]);
      expect(base.pathComponents).toEqual([]);
    },
  );

  it.each(["dir/new", "dir//new///", "dir/./new", "dir/../dir/new/"])(
    "resolves the parent of %s with repeated and trailing separators",
    (path) => {
      const { base, resolver, directory } = fixture();
      expect(runSync(resolver.resolveParent(base, path))).toEqual({
        mount: base.mount,
        parent: directory,
        name: "new",
        pathComponents: ["dir", "new"],
        ancestors: [base.inode, directory],
      });
      expect(runSync(resolver.resolveParent(base, "new///"))).toMatchObject({
        parent: base.inode,
        name: "new",
      });
    },
  );

  it("preserves missing-leaf, trailing slash and invalid-parent errors", () => {
    const { base, resolver } = fixture();
    expect(runSync(resolver.resolveOrCreate(base, "dir/new", true))).toMatchObject({
      kind: "missing",
      parent: { name: "new", pathComponents: ["dir", "new"] },
    });
    for (const path of ["dir/new/", "dir/missing/new"]) {
      expect(() => runSync(resolver.resolveOrCreate(base, path, true))).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    }
    expect(() => runSync(resolver.resolve(base, "dir/file/", true))).toThrow(errno(54));
    for (const path of ["dir/.", "dir/..", ".", ".."]) {
      expect(() => runSync(resolver.resolveParent(base, path))).toThrow(errno(28));
    }
  });

  it("follows symlinks before dot-dot and confines absolute targets to the mount", () => {
    const { base, resolver, storage, directory, file } = fixture();
    storage.create(directory, "nested", { type: "directory", exclusive: true });
    storage.create(storage.root, "link", {
      type: "symlink",
      exclusive: true,
      target: "dir/nested",
    });
    const absolute = storage.create(directory, "absolute", {
      type: "symlink",
      exclusive: true,
      target: "/dir/file",
    });
    expect(runSync(resolver.resolve(base, "link/../file", true)).inode).toBe(file);
    expect(runSync(resolver.resolve(base, "dir/absolute", true)).inode).toBe(file);
    expect(runSync(resolver.resolve(base, "dir/absolute", false)).inode).toBe(absolute);
    expect(runSync(resolver.resolveParent(base, "link/../new"))).toMatchObject({
      parent: directory,
      pathComponents: ["dir", "new"],
    });
    expect(() => runSync(resolver.resolve(base, "../dir", true))).toThrow(errno(76));
  });

  it.each([
    ["a", 4096],
    ["é", 2048],
    ["€", 1365],
    ["🎉", 1024],
    ["\ud800", 1365],
  ])("keeps the UTF-8 path limit for %j", (character, count) => {
    const { base, resolver, storage } = fixture();
    const name = character.repeat(count);
    const file = storage.create(storage.root, name, { type: "file", exclusive: true });
    expect(runSync(resolver.resolve(base, name, true)).inode).toBe(file);
    const overlong = name + "xxxx";
    expect(() => runSync(resolver.resolve(base, overlong, true))).toThrow(errno(37));
    expect(() => runSync(resolver.resolveParent(base, overlong))).toThrow(errno(37));
    expect(() => runSync(resolver.resolve(base, `/${overlong}`, true))).toThrow(errno(76));
    expect(() => runSync(resolver.resolve(base, `${overlong}\0`, true))).toThrow(errno(28));
  });
});
