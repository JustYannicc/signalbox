// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory test database, never live userdata.
import { describe, expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createNodeFs, KernelOpenFlags } from "../NodeFs.ts";

const clock = () => 1_800_000_000_000_000_001n;
const fsExports = [
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "close",
  "closeSync",
  "constants",
  "createReadStream",
  "createWriteStream",
  "existsSync",
  "fchmod",
  "fchmodSync",
  "fchown",
  "fstat",
  "fstatSync",
  "fsync",
  "fsyncSync",
  "ftruncateSync",
  "lstatSync",
  "mkdirSync",
  "mkdtempSync",
  "open",
  "openSync",
  "promises",
  "read",
  "readFileSync",
  "readSync",
  "readdirSync",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "stat",
  "statSync",
  "statfsSync",
  "unlink",
  "unlinkSync",
  "unwatchFile",
  "utimes",
  "utimesSync",
  "watch",
  "watchFile",
  "writeFile",
  "writeFileSync",
  "writeSync",
] as const;
const fsPromiseExports = [
  "access",
  "appendFile",
  "chmod",
  "constants",
  "copyFile",
  "link",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "unlink",
  "utimes",
  "watch",
  "writeFile",
] as const;

function nodeFsFixture() {
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
      const name = `node_fs_test_${transactionDepth++}`;
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

describe("Node fs modules backed by KernelFileSystem", () => {
  it("opens real SQL files and directories with the official numeric nonblocking flags", async () => {
    const fixture = nodeFsFixture();
    const fs = createNodeFs(fixture.kernelFs).fs;
    try {
      fs.mkdirSync("/work");
      fs.writeFileSync("/work/source.txt", "source bytes");
      const directory = fs.openSync("/work", KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY);
      const file = await fs.promises.open(`/proc/self/fd/${directory}/source.txt`, 657664);
      try {
        expect(await file.readFile("utf8")).toBe("source bytes");
      } finally {
        await file.close();
      }
      await expect(
        fs.promises.open(`/proc/self/fd/${directory}/new.txt`, 657664),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const directoryHandle = await fs.promises.open("/work", 2048);
      try {
        expect((await directoryHandle.stat()).isDirectory()).toBe(true);
      } finally {
        await directoryHandle.close();
      }
      fs.closeSync(directory);
    } finally {
      fixture.close();
    }
  });

  it("exposes own named exports and shares one promises module", () => {
    const fixture = nodeFsFixture();
    try {
      const modules = createNodeFs(fixture.kernelFs);
      expect(Object.getPrototypeOf(modules.fs)).toBeNull();
      expect(fsExports.filter((name) => !Object.hasOwn(modules.fs, name))).toEqual([]);
      expect(
        fsPromiseExports.filter((name) => !Object.hasOwn(modules["fs/promises"], name)),
      ).toEqual([]);
      expect(modules.fs.default).toBe(modules.fs);
      expect(modules["fs/promises"].default).toBe(modules["fs/promises"]);
      expect(modules.fs.promises).toBe(modules["fs/promises"]);
      expect(modules.fs.constants).toBe(modules["fs/promises"].constants);
      expect(KernelOpenFlags.O_APPEND).toBe(0o2000);
    } finally {
      fixture.close();
    }
  });

  it("uses append descriptors and preserves encoded and binary bytes", () => {
    const fixture = nodeFsFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.mkdirSync("/docs");
      fs.writeFileSync("/docs/notes", "before:");
      fs.appendFileSync("/docs/notes", "é🐈");
      fs.appendFileSync("/docs/notes", NodeBuffer.Buffer.from([0, 0xff]));
      expect(fs.readFileSync("/docs/notes")).toEqual(
        NodeBuffer.Buffer.concat([
          NodeBuffer.Buffer.from("before:é🐈"),
          NodeBuffer.Buffer.from([0, 0xff]),
        ]),
      );
      expect(fs.readFileSync(new URL("file:///docs/notes"), "utf8")).toBe("before:é🐈\u0000�");
    } finally {
      fixture.close();
    }
  });

  it("returns kernel identity and type data without inventing permissions", () => {
    const fixture = nodeFsFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/entry", "abc");
      const stat = fs.statSync("/entry");
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBe(3);
      expect(stat.uid).toBe(-1);
      expect(stat.gid).toBe(-1);
      expect(Number(stat.mode) & 0o777).toBe(0);
      const bigIntStat = fs.statSync("/entry", { bigint: true });
      expect(bigIntStat.ino).toBeTypeOf("bigint");
      expect(bigIntStat.atimeNs).toBeTypeOf("bigint");
      expect(fs.statSync("/dev/null").isCharacterDevice()).toBe(true);
      expect(fs.readFileSync("/dev/null")).toEqual(NodeBuffer.Buffer.alloc(0));
    } finally {
      fixture.close();
    }
  });

  it("keeps callback completion asynchronous and preserves POSIX error fields", async () => {
    const fixture = nodeFsFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      let inCall = true;
      const callbackResult = new Promise<void>((resolve, reject) => {
        fs.writeFile("/callback", "done", (error) => {
          try {
            expect(inCall).toBe(false);
            expect(error).toBeNull();
            resolve();
          } catch (cause) {
            reject(cause);
          }
        });
      });
      inCall = false;
      await callbackResult;

      try {
        fs.readFileSync("/missing");
        throw new Error("expected ENOENT");
      } catch (error) {
        expect(error).toMatchObject({ code: "ENOENT", syscall: "readFile", path: "/missing" });
      }
    } finally {
      fixture.close();
    }
  });

  it("exposes promisifiable realpath.native over the current kernel filesystem", async () => {
    const fixture = nodeFsFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.mkdirSync("/work/target", { recursive: true });
      fs.symlinkSync("target", "/work/link");
      fixture.kernelFs.chdir("/work");

      let inCall = true;
      let callbackCalls = 0;
      const callbackResult = new Promise<string | NodeBuffer.Buffer>((resolve, reject) => {
        fs.realpath.native("link", (error, resolvedPath) => {
          callbackCalls++;
          try {
            expect(inCall).toBe(false);
            expect(error).toBeNull();
            resolve(resolvedPath);
          } catch (cause) {
            reject(cause);
          }
        });
      });
      inCall = false;
      expect(await callbackResult).toBe("/work/target");
      expect(callbackCalls).toBe(1);

      const promisifiedRealpath = NodeUtil.promisify(fs.realpath.native);
      expect(await promisifiedRealpath("link")).toBe("/work/target");
      const bufferPath = await new Promise<string | NodeBuffer.Buffer>((resolve, reject) => {
        fs.realpath.native("link", { encoding: "buffer" }, (error, resolvedPath) => {
          if (error) reject(error);
          else resolve(resolvedPath);
        });
      });
      expect(NodeBuffer.Buffer.isBuffer(bufferPath)).toBe(true);
      expect(bufferPath).toEqual(NodeBuffer.Buffer.from("/work/target"));

      const callbackError = await new Promise<unknown>((resolve) => {
        fs.realpath.native("missing", (error) => resolve(error));
      });
      expect(callbackError).toMatchObject({
        code: "ENOENT",
        path: "missing",
        syscall: "realpath",
      });

      const promiseError = await promisifiedRealpath("missing").catch((error: unknown) => error);
      expect(promiseError).toMatchObject({
        code: "ENOENT",
        path: "missing",
        syscall: "realpath",
      });

      const regularCallback = await new Promise<string | NodeBuffer.Buffer>((resolve, reject) => {
        fs.realpath("link", (error, resolvedPath) => {
          if (error) reject(error);
          else resolve(resolvedPath);
        });
      });
      expect(regularCallback).toBe("/work/target");
    } finally {
      fixture.close();
    }
  });

  it("supports promises FileHandle and native Node stream behavior", async () => {
    const fixture = nodeFsFixture();
    try {
      const modules = createNodeFs(fixture.kernelFs);
      const handle = await modules["fs/promises"].open("/stream", "w+");
      await handle.writeFile("hello 🐈");
      await handle.sync();
      expect(await handle.readFile({ encoding: "utf8" })).toBe("");
      await handle.close();
      expect(await modules["fs/promises"].readFile("/stream", "utf8")).toBe("hello 🐈");

      await new Promise<void>((resolve, reject) => {
        const stream = modules.fs.createWriteStream("/streamed");
        stream.once("error", reject);
        stream.once("close", resolve);
        stream.end("stream 🐈");
      });
      const chunks: NodeBuffer.Buffer[] = [];
      for await (const chunk of modules.fs.createReadStream("/streamed")) {
        chunks.push(NodeBuffer.Buffer.from(chunk));
      }
      expect(NodeBuffer.Buffer.concat(chunks).toString("utf8")).toBe("stream 🐈");
    } finally {
      fixture.close();
    }
  });

  it("returns useful Dirent values and fails unsupported APIs with ENOTSUP", () => {
    const fixture = nodeFsFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      fs.writeFileSync("/entry", "x");
      const entries = fs.readdirSync("/", { withFileTypes: true });
      expect(
        entries.some((entry) => {
          if (typeof entry === "string" || NodeBuffer.Buffer.isBuffer(entry)) return false;
          return entry.name === "entry" && entry.isFile();
        }),
      ).toBe(true);
      const unsupported = [() => fs.chmodSync("/entry", 0o600), () => fs.statfsSync("/entry")];
      for (const operation of unsupported) {
        let thrown: unknown;
        try {
          operation();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: "ENOTSUP" });
      }
    } finally {
      fixture.close();
    }
  });

  it("creates nested directories recursively and defaults callback open to read mode", async () => {
    const fixture = nodeFsFixture();
    try {
      const { fs } = createNodeFs(fixture.kernelFs);
      expect(fs.mkdirSync("/recursive/child/grandchild", { recursive: true })).toBe("/recursive");
      expect(fs.statSync("/recursive/child/grandchild").isDirectory()).toBe(true);
      fs.writeFileSync("/recursive/child/grandchild/open", "contents");

      const syncFd = fs.openSync("/recursive/child/grandchild/open");
      fs.closeSync(syncFd);

      const fd = await new Promise<number>((resolve, reject) => {
        fs.open("/recursive/child/grandchild/open", (error, openedFd) => {
          if (error) reject(error);
          else resolve(openedFd);
        });
      });
      fs.closeSync(fd);
      fs.rmSync("/recursive", { recursive: true });
      expect(fs.existsSync("/recursive")).toBe(false);
    } finally {
      fixture.close();
    }
  });
});
