// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory test database, never live userdata.
import { describe, expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import type * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createNodeFs } from "../NodeFs.ts";

const clock = () => 1_800_000_000_000_000_001n;

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function filesystemFixture() {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  let transactionDepth = 0;
  const facetStorage: FacetStorage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const name = `node_fs_review_${transactionDepth++}`;
      database.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        database.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${name}`);
        database.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        transactionDepth--;
      }
    },
  };
  const storage = createFacetSqliteStorage(facetStorage, clock);
  const kernelFs = new KernelFileSystem({ mounts: [{ path: "/", storage }], cwd: "/" });
  return {
    kernelFs,
    close() {
      try {
        kernelFs.dispose();
      } finally {
        database.close();
      }
    },
  };
}

describe("Node fs filesystem edge contracts", () => {
  it("keeps recursive mkdir components for kernel symlink traversal", () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.mkdirSync("/a");
      fs.mkdirSync("/b/sub", { recursive: true });
      fs.symlinkSync("/b/sub", "/a/link");

      fs.mkdirSync("/a/link/../new", { recursive: true });

      expect(fs.statSync("/b/new").isDirectory()).toBe(true);
      expect(fs.existsSync("/a/new")).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("preserves symlink and dot-dot parents for rm and directory entry metadata", async () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.mkdirSync("/a", { recursive: true });
      fs.mkdirSync("/b/sub", { recursive: true });
      fs.symlinkSync("/b/sub", "/a/link");

      fs.mkdirSync("/a/tree");
      fs.mkdirSync("/b/tree");
      fs.writeFileSync("/a/tree/same", "keep");
      fs.writeFileSync("/b/tree/same", "remove");
      expect(caught(() => fs.rmSync("/a/link/../tree", { recursive: true }))).toBeUndefined();
      expect(fs.readFileSync("/a/tree/same", "utf8")).toBe("keep");
      expect(fs.existsSync("/b/tree")).toBe(false);

      fs.mkdirSync("/a/items");
      fs.mkdirSync("/b/items");
      fs.writeFileSync("/a/items/entry", "file");
      fs.mkdirSync("/b/items/entry");
      fs.mkdirSync("/a/items/folder");
      fs.writeFileSync("/b/items/folder", "file");
      fs.mkdirSync("/a/items/link");
      fs.symlinkSync("/b/items/folder", "/b/items/link");

      const aliasedItems = "/a/link/../items";
      const readdirEntries = fs
        .readdirSync(aliasedItems, {
          withFileTypes: true,
        })
        .filter(
          (entry): entry is NodeFS.Dirent<string> | NodeFS.Dirent<NodeBuffer.Buffer> =>
            typeof entry === "object" && "name" in entry,
        );
      const readdirByName = new Map(readdirEntries.map((entry) => [String(entry.name), entry]));
      expect(readdirByName.get("entry")?.isDirectory()).toBe(true);
      expect(readdirByName.get("folder")?.isFile()).toBe(true);
      expect(readdirByName.get("link")?.isSymbolicLink()).toBe(true);

      const directory = await fs.promises.opendir(aliasedItems);
      const openedEntries: NodeFS.Dirent<string | NodeBuffer.Buffer>[] = [];
      for await (const entry of directory) openedEntries.push(entry);
      const openedByName = new Map(openedEntries.map((entry) => [String(entry.name), entry]));
      for (const entry of openedEntries) {
        expect(entry).toMatchObject({ parentPath: aliasedItems, path: aliasedItems });
      }
      expect(openedByName.get("entry")?.isDirectory()).toBe(true);
      expect(openedByName.get("folder")?.isFile()).toBe(true);
      expect(openedByName.get("link")?.isSymbolicLink()).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("bounds fd streams by the inclusive end at the shared descriptor offset", async () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/range", "abcdef");

      const initialFd = fs.openSync("/range", "r");
      const initialChunks: NodeBuffer.Buffer[] = [];
      for await (const chunk of fs.createReadStream("/range", {
        fd: initialFd,
        end: 1,
        autoClose: false,
      })) {
        initialChunks.push(NodeBuffer.Buffer.from(chunk));
      }
      expect(NodeBuffer.Buffer.concat(initialChunks).toString()).toBe("ab");
      fs.closeSync(initialFd);

      const continuedFd = fs.openSync("/range", "r");
      const prefix = NodeBuffer.Buffer.alloc(2);
      expect(fs.readSync(continuedFd, prefix, 0, 2, null)).toBe(2);
      const continuedChunks: NodeBuffer.Buffer[] = [];
      for await (const chunk of fs.createReadStream("/range", {
        fd: continuedFd,
        end: 3,
        autoClose: false,
      })) {
        continuedChunks.push(NodeBuffer.Buffer.from(chunk));
      }
      expect(NodeBuffer.Buffer.concat(continuedChunks).toString()).toBe("cd");
      const afterEnd = NodeBuffer.Buffer.alloc(1);
      expect(fs.readSync(continuedFd, afterEnd, 0, 1, null)).toBe(1);
      expect(afterEnd.toString()).toBe("e");
      fs.closeSync(continuedFd);
    } finally {
      fixture.close();
    }
  });

  it("binds opendir to the opening cwd and rejects missing paths on open", async () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.mkdirSync("/first/child", { recursive: true });
      fs.mkdirSync("/second/child", { recursive: true });
      fs.writeFileSync("/first/child/first", "first");
      fs.writeFileSync("/second/child/second", "second");

      fixture.kernelFs.chdir("/first");
      const directory = await fs.promises.opendir("child");
      fixture.kernelFs.chdir("/second");
      expect((await directory.read())?.name).toBe("first");
      await directory.close();
      await expect(fs.promises.opendir("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      fixture.close();
    }
  });

  it("validates callback rm before mutation and rejects nonrecursive directory removal", async () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.mkdirSync("/callback-directory");
      expect(() => fs.rm("/callback-directory", { recursive: true })).toThrow(TypeError);
      expect(fs.statSync("/callback-directory").isDirectory()).toBe(true);

      fs.writeFileSync("/callback-file", "file");
      await new Promise<void>((resolve, reject) => {
        fs.rm("/callback-file", (error) => (error ? reject(error) : resolve()));
      });
      expect(fs.existsSync("/callback-file")).toBe(false);

      expect(caught(() => fs.rmSync("/callback-directory"))).toMatchObject({ code: "EISDIR" });
      expect(caught(() => fs.rmSync("/callback-directory", { force: true }))).toMatchObject({
        code: "EISDIR",
      });
      expect(fs.statSync("/callback-directory").isDirectory()).toBe(true);
      fs.rmSync("/callback-directory", { recursive: true });
    } finally {
      fixture.close();
    }
  });

  it("rejects invalid public callbacks synchronously before unlinking", async () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      const invalidCallbacks = [null, 1, {}];
      const victims = invalidCallbacks.map((_, index) => `/victim-${index}`);

      for (const [index, callback] of invalidCallbacks.entries()) {
        const victim = victims[index]!;
        fs.writeFileSync(victim, "keep");
        expect(() => Reflect.apply(fs.unlink, fs, [victim, callback as never])).toThrow(TypeError);
        expect(fs.readFileSync(victim, "utf8")).toBe("keep");
      }

      await Promise.resolve();
      for (const victim of victims) expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    } finally {
      fixture.close();
    }
  });
});
