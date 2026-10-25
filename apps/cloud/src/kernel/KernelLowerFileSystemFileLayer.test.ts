import { describe, expect, it } from "vite-plus/test";
import { createNodeFs } from "../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import {
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const encoder = new TextEncoder();

function entry(path: string, type: KernelLowerFileSystemEntry["stat"]["type"], size = 0n) {
  return {
    path,
    stat: {
      type,
      size,
      nlink: type === "directory" ? 2n : 1n,
      atimeNs: 11n,
      mtimeNs: 12n,
      ctimeNs: 13n,
    },
    metadata: { mode: type === "directory" ? 0o750 : 0o640, uid: 1000, gid: 1000 },
  } satisfies KernelLowerFileSystemEntry;
}

type LowerReader = (path: string, offset: bigint, length: number) => Promise<Uint8Array>;

function fixture(
  files: ReadonlyMap<string, Uint8Array>,
  upperDestination?: Uint8Array,
  readLower?: LowerReader,
) {
  const database = sqliteFixture();
  const makeFilesystem = (initialize: boolean) => {
    const storage = createFacetSqliteStorage(database.storage, () => 20n);
    if (initialize) storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    const kernel = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: {
        credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
        umask: 0o022,
      },
    });
    const fs = createNodeFs(kernel).fs;
    if (initialize && upperDestination !== undefined) {
      fs.mkdirSync("/home/node", { recursive: true });
      fs.writeFileSync("/home/node/destination", upperDestination);
    }
    return { fs, kernel, lower: kernel.installLowerFileSystem(source) };
  };

  const entries = [
    entry("/home", "directory"),
    entry("/home/node", "directory"),
    ...[...files].map(([path, bytes]) => entry(path, "file", BigInt(bytes.byteLength))),
  ];
  const byPath = new Map(entries.map((value) => [value.path, value]));
  const reads: Array<{ path: string; offset: bigint; length: number }> = [];
  const source: KernelLowerFileSystemSource = {
    lookup(paths) {
      return paths.map((path) => byPath.get(path));
    },
    lookupKnown(paths) {
      return paths.map((path) => byPath.get(path));
    },
    readdirKnown(path) {
      return entries.filter(
        (value) => value.path !== path && value.path.slice(0, value.path.lastIndexOf("/")) === path,
      );
    },
    async readdir(path) {
      return entries.filter(
        (value) => value.path !== path && value.path.slice(0, value.path.lastIndexOf("/")) === path,
      );
    },
    readlinkKnown() {
      return undefined;
    },
    async readlink() {
      throw Object.assign(new Error("Not a symlink"), { code: "EINVAL" });
    },
    async read(path, offset, length) {
      reads.push({ path, offset, length });
      if (readLower !== undefined) return readLower(path, offset, length);
      const bytes = files.get(path) ?? new Uint8Array();
      return bytes.slice(Number(offset), Number(offset) + length);
    },
  };
  let mounted = makeFilesystem(true);

  return {
    get fs() {
      return mounted.fs;
    },
    reads,
    reopen() {
      mounted.lower.dispose();
      mounted.kernel.dispose();
      mounted = makeFilesystem(false);
      return mounted.fs;
    },
    close() {
      mounted.lower.dispose();
      mounted.kernel.dispose();
      database.close();
    },
  };
}

describe("lower file copy-up through Node fs", () => {
  it("appends exact bytes and updates a descriptor opened before copy-up", async () => {
    const path = "/home/node/.bashrc";
    const lowerBytes = encoder.encode("old lower bytes\n");
    const original = lowerBytes.slice();
    const appended = encoder.encode("new upper bytes\n");
    const test = fixture(new Map([[path, lowerBytes]]));
    let fd: number | undefined;
    try {
      fd = test.fs.openSync(path, "r");
      await test.fs.promises.appendFile(path, appended);

      expect(test.fs.readFileSync(path)).toEqual(
        Buffer.concat([Buffer.from(original), Buffer.from(appended)]),
      );
      const oldReference = new Uint8Array(original.byteLength + appended.byteLength);
      expect(test.fs.readSync(fd, oldReference, 0, oldReference.byteLength, 0)).toBe(
        oldReference.byteLength,
      );
      expect([...oldReference]).toEqual([...original, ...appended]);
      expect(test.fs.fstatSync(fd).size).toBe(oldReference.byteLength);
      expect([...lowerBytes]).toEqual([...original]);
      expect(test.reads).toEqual([{ path, offset: 0n, length: original.byteLength }]);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual([".bashrc"]);
    } finally {
      if (fd !== undefined) test.fs.closeSync(fd);
      test.close();
    }
  });

  it("replaces a lower file on writeFile while preserving an open reference", async () => {
    const path = "/home/node/settings.json";
    const lowerBytes = encoder.encode('{"old":true}\n');
    const original = lowerBytes.slice();
    const replacement = encoder.encode('{"new":true}\n');
    const test = fixture(new Map([[path, lowerBytes]]));
    let fd: number | undefined;
    try {
      fd = test.fs.openSync(path, "r");
      test.fs.writeFileSync(path, replacement);

      const oldReference = new Uint8Array(replacement.byteLength);
      expect(test.fs.readSync(fd, oldReference, 0, oldReference.byteLength, 0)).toBe(
        replacement.byteLength,
      );
      expect([...oldReference]).toEqual([...replacement]);
      expect(test.fs.fstatSync(fd).size).toBe(replacement.byteLength);
      expect([...lowerBytes]).toEqual([...original]);
      expect(test.reads).toEqual([]);
    } finally {
      if (fd !== undefined) test.fs.closeSync(fd);
      test.close();
    }
  });

  it("reports ENOTSUP when a synchronous mutation needs lower file bytes", () => {
    const path = "/home/node/.bashrc";
    const lowerBytes = encoder.encode("lower bytes\n");
    const original = lowerBytes.slice();
    const test = fixture(new Map([[path, lowerBytes]]));
    try {
      expect(() => test.fs.appendFileSync(path, "append")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(() => test.fs.renameSync(path, "/home/node/.bashrc.next")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );

      expect(test.fs.existsSync(path)).toBe(true);
      expect(test.fs.existsSync("/home/node/.bashrc.next")).toBe(false);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual([".bashrc"]);
      expect(test.reads).toEqual([]);
      expect([...lowerBytes]).toEqual([...original]);
    } finally {
      test.close();
    }
  });

  it("keeps a lower file hidden after unlinking its copied-up replacement", async () => {
    const path = "/home/node/.bashrc";
    const lowerBytes = encoder.encode("original lower bytes\n");
    const original = lowerBytes.slice();
    const test = fixture(new Map([[path, lowerBytes]]));
    try {
      await test.fs.promises.appendFile(path, "upper change\n");
      test.fs.unlinkSync(path);

      expect(test.fs.existsSync(path)).toBe(false);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual([]);
      expect([...lowerBytes]).toEqual([...original]);
    } finally {
      test.close();
    }
  });

  it("keeps a lower file visible after a short copy read and cleans up the stage", async () => {
    const path = "/home/node/.bashrc";
    const lowerBytes = encoder.encode("original lower bytes\n");
    const original = lowerBytes.slice();
    const appended = encoder.encode("later append\n");
    let returnShortRead = true;
    const test = fixture(new Map([[path, lowerBytes]]), undefined, async (_path, offset) => {
      if (returnShortRead) return offset === 0n ? original.slice(0, 2) : new Uint8Array();
      return original.slice(Number(offset));
    });
    try {
      await expect(test.fs.promises.appendFile(path, appended)).rejects.toMatchObject({
        code: "EIO",
      });

      expect(test.fs.existsSync(path)).toBe(true);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual([".bashrc"]);
      expect([...lowerBytes]).toEqual([...original]);

      returnShortRead = false;
      await test.fs.promises.appendFile(path, appended);
      expect([...test.fs.readFileSync(path)]).toEqual([...original, ...appended]);
      expect([...lowerBytes]).toEqual([...original]);
    } finally {
      test.close();
    }
  });

  it("renames a lower source over a lower destination and hides the old name", async () => {
    const sourcePath = "/home/node/source.log";
    const destinationPath = "/home/node/destination";
    const sourceBytes = encoder.encode("source contents\n");
    const destinationBytes = encoder.encode("old lower destination\n");
    const sourceBefore = sourceBytes.slice();
    const destinationBefore = destinationBytes.slice();
    const test = fixture(
      new Map([
        [sourcePath, sourceBytes],
        [destinationPath, destinationBytes],
      ]),
    );
    let fd: number | undefined;
    try {
      fd = test.fs.openSync(sourcePath, "r");
      await test.fs.promises.rename(sourcePath, destinationPath);

      expect(test.fs.existsSync(sourcePath)).toBe(false);
      expect([...test.fs.readFileSync(destinationPath)]).toEqual([...sourceBefore]);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual(["destination"]);
      const oldReference = new Uint8Array(sourceBefore.byteLength);
      expect(test.fs.readSync(fd, oldReference, 0, oldReference.byteLength, 0)).toBe(
        oldReference.byteLength,
      );
      expect(oldReference).toEqual(sourceBefore);
      expect([...sourceBytes]).toEqual([...sourceBefore]);
      expect([...destinationBytes]).toEqual([...destinationBefore]);
    } finally {
      if (fd !== undefined) test.fs.closeSync(fd);
      test.close();
    }
  });

  it("renames a lower source over an existing upper destination", async () => {
    const sourcePath = "/home/node/source.log";
    const destinationPath = "/home/node/destination";
    const sourceBytes = encoder.encode("lower source contents\n");
    const upperBytes = encoder.encode("old upper destination\n");
    const sourceBefore = sourceBytes.slice();
    const upperBefore = upperBytes.slice();
    const test = fixture(new Map([[sourcePath, sourceBytes]]), upperBytes);
    try {
      await test.fs.promises.rename(sourcePath, destinationPath);

      expect(test.fs.existsSync(sourcePath)).toBe(false);
      expect([...test.fs.readFileSync(destinationPath)]).toEqual([...sourceBefore]);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual(["destination"]);
      expect([...sourceBytes]).toEqual([...sourceBefore]);
      expect([...upperBytes]).toEqual([...upperBefore]);
    } finally {
      test.close();
    }
  });

  it("replaces an upper symlink when renaming a lower file over it", async () => {
    const sourcePath = "/home/node/source.log";
    const destinationPath = "/home/node/destination";
    const sourceBytes = encoder.encode("lower source contents\n");
    const sourceBefore = sourceBytes.slice();
    const test = fixture(new Map([[sourcePath, sourceBytes]]));
    try {
      test.fs.symlinkSync("missing-target", destinationPath);
      await test.fs.promises.rename(sourcePath, destinationPath);

      expect(test.fs.existsSync(sourcePath)).toBe(false);
      expect([...test.fs.readFileSync(destinationPath)]).toEqual([...sourceBefore]);
      expect(test.fs.lstatSync(destinationPath).isFile()).toBe(true);
      expect([...sourceBytes]).toEqual([...sourceBefore]);
    } finally {
      test.close();
    }
  });

  it("keeps a lower source hidden after reopening the upper filesystem", async () => {
    const sourcePath = "/home/node/source.log";
    const destinationPath = "/home/node/destination.log";
    const sourceBytes = encoder.encode("persistent source contents\n");
    const sourceBefore = sourceBytes.slice();
    const test = fixture(new Map([[sourcePath, sourceBytes]]));
    try {
      await test.fs.promises.rename(sourcePath, destinationPath);
      test.reopen();

      expect(test.fs.existsSync(sourcePath)).toBe(false);
      expect([...(await test.fs.promises.readFile(destinationPath))]).toEqual([...sourceBefore]);
      expect(test.fs.readdirSync("/home/node").map(String)).toEqual(["destination.log"]);
      expect([...sourceBytes]).toEqual([...sourceBefore]);
    } finally {
      test.close();
    }
  });
});
