import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import {
  KernelFileSystemUnavailable,
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function entry(
  path: string,
  type: "directory" | "file",
  nativeIno: bigint,
): KernelLowerFileSystemEntry {
  return {
    path,
    stat: {
      type,
      size: 0n,
      nlink: type === "directory" ? 2n : 1n,
      atimeNs: 1n,
      mtimeNs: 2n,
      ctimeNs: 3n,
    },
    metadata: { mode: type === "directory" ? 0o755 : 0o644, uid: 1000, gid: 1000 },
    nativeIno,
    nativeDev: 9n,
  };
}

async function fixture(path = "/machine") {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  const entries = new Map(
    [
      entry("/", "directory", 70n),
      entry("/machine", "directory", 71n),
      entry("/machine/child", "file", 72n),
    ].map((value) => [value.path, value]),
  );
  const requests: string[] = [];
  let lookup: KernelLowerFileSystemSource["lookup"] | undefined;
  const source: KernelLowerFileSystemSource = {
    async lookup(paths, signal) {
      requests.push(...paths);
      return lookup === undefined ? paths.map((path) => entries.get(path)) : lookup(paths, signal);
    },
    async readdir(path) {
      return [...entries.values()].filter(
        (value) =>
          value.path !== path && (value.path.slice(0, value.path.lastIndexOf("/")) || "/") === path,
      );
    },
    async read() {
      throw new Error("Descriptor metadata must not read file bytes");
    },
    async readlink() {
      throw new Error("No lower symlinks in this fixture");
    },
  };
  const lower = files.installLowerFileSystem(source);
  await files.prepareLowerPaths([path]);
  expect(await lower.isLower(path)).toBe(true);
  const fd = files.open(path, KernelOpenFlags.O_PATH);
  const before = files.fstat(fd);
  lower.invalidate();
  requests.length = 0;
  return {
    files,
    lower,
    fd,
    before,
    entries,
    requests,
    setLookup(value: typeof lookup) {
      lookup = value;
    },
    close() {
      files.dispose();
      lower.dispose();
      database.close();
    },
  };
}

const aliases = ["/proc/self/fd", "/dev/fd"] as const;
const methods = ["statAsync", "readdirAsync", "lstatAsync"] as const;

describe("asynchronous aliases of retained lower descriptors", () => {
  it.each(aliases.flatMap((prefix) => methods.map((method) => ({ prefix, method }))))(
    "$method follows $prefix after public lower invalidation",
    async ({ prefix, method }) => {
      const test = await fixture();
      try {
        const old = test.entries.get("/machine")!;
        test.entries.set("/machine", {
          ...old,
          stat: { ...old.stat, mtimeNs: 21n },
          metadata: { ...old.metadata, mode: 0o750 },
        });
        const alias = `${prefix}/${test.fd}`;
        if (method === "readdirAsync")
          await expect(test.files.readdirAsync(alias)).resolves.toEqual(["child"]);
        else if (method === "statAsync")
          await expect(test.files.statAsync(alias)).resolves.toMatchObject({
            type: "directory",
            ino: test.before.ino,
            dev: test.before.dev,
            nativeIno: 71n,
            nativeDev: 9n,
            mtimeNs: 21n,
            posix: { mode: 0o750, uid: 1000, gid: 1000 },
          });
        else
          await expect(test.files.lstatAsync(alias)).resolves.toMatchObject({
            type: "symlink",
            size: BigInt("/machine".length),
            ino: (1n << 32n) + BigInt(test.fd),
          });
        expect(test.requests).toContain("/machine");
      } finally {
        test.close();
      }
    },
  );

  it.each(aliases)(
    "preserves a lower file's identity and magic-link path through %s",
    async (prefix) => {
      const test = await fixture("/machine/child");
      try {
        const alias = `${prefix}/${test.fd}`;
        const old = test.entries.get("/machine/child")!;
        test.entries.set(old.path, { ...old, stat: { ...old.stat, size: 37n } });
        await expect(test.files.statAsync(alias)).resolves.toMatchObject({
          type: "file",
          size: 37n,
          ino: test.before.ino,
          dev: test.before.dev,
          nativeIno: 72n,
          nativeDev: 9n,
        });
        test.lower.invalidate();
        await expect(test.files.lstatAsync(alias)).resolves.toMatchObject({
          type: "symlink",
          size: BigInt(old.path.length),
        });
        test.lower.invalidate();
        await expect(test.files.readdirAsync(alias)).rejects.toMatchObject({ code: "ENOTDIR" });
        test.files.close(test.fd);
        await expect(test.files.statAsync(alias)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(test.files.lstatAsync(alias)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(test.files.readdirAsync(alias)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        test.close();
      }
    },
  );

  it.each(aliases)("checks refreshed directory read permissions through %s", async (prefix) => {
    const test = await fixture();
    try {
      const old = test.entries.get("/machine")!;
      test.entries.set(old.path, { ...old, metadata: { ...old.metadata, mode: 0o111 } });
      await expect(test.files.readdirAsync(`${prefix}/${test.fd}`)).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      test.close();
    }
  });

  it.each(methods)("%s preserves lower availability and POSIX errors", async (method) => {
    const test = await fixture();
    try {
      const unavailable = new KernelFileSystemUnavailable("descriptor lookup failed");
      test.setLookup(async () => {
        throw unavailable;
      });
      await expect(test.files[method](`/proc/self/fd/${test.fd}`)).rejects.toBe(unavailable);
      test.lower.invalidate();
      test.setLookup(async () => {
        throw Object.assign(new Error("lower denied"), { code: "EACCES" });
      });
      await expect(test.files[method](`/dev/fd/${test.fd}`)).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      test.close();
    }
  });

  it.each(methods)(
    "%s aborts before I/O and across a descriptor metadata await",
    async (method) => {
      const test = await fixture();
      const reason = new Error("descriptor operation cancelled");
      const started = Promise.withResolvers<AbortSignal | undefined>();
      const result = Promise.withResolvers<readonly (KernelLowerFileSystemEntry | undefined)[]>();
      try {
        await expect(
          test.files[method](`/proc/self/fd/${test.fd}`, AbortSignal.abort(reason)),
        ).rejects.toBe(reason);
        expect(test.requests).toEqual([]);
        const controller = new AbortController();
        test.setLookup(async (_paths, signal) => {
          started.resolve(signal);
          return result.promise;
        });
        const operation = test.files[method](`/dev/fd/${test.fd}`, controller.signal);
        expect(await started.promise).toBe(controller.signal);
        controller.abort(reason);
        result.resolve([test.entries.get("/machine")]);
        await expect(operation).rejects.toBe(reason);
        test.lower.invalidate();
        test.setLookup(undefined);
        await expect(test.files.readdirAsync(`/dev/fd/${test.fd}`)).resolves.toEqual(["child"]);
      } finally {
        result.resolve([]);
        test.close();
      }
    },
  );
});
