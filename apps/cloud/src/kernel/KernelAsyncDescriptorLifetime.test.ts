import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import type { Inode, Stat } from "./storage.ts";
import type { PosixMetadata } from "./PosixStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const aliases = ["/proc/self/fd", "/dev/fd"];
const statCases = [
  {
    method: "statAsync",
    fails: false,
    cleanupFails: false,
    pendingAbort: false,
    releaseAbort: false,
  },
  {
    method: "lstatAsync",
    fails: false,
    cleanupFails: false,
    pendingAbort: false,
    releaseAbort: false,
  },
  {
    method: "statAsync",
    fails: true,
    cleanupFails: true,
    pendingAbort: false,
    releaseAbort: false,
  },
  {
    method: "statAsync",
    fails: false,
    cleanupFails: true,
    pendingAbort: false,
    releaseAbort: false,
  },
  {
    method: "statAsync",
    fails: false,
    cleanupFails: true,
    pendingAbort: true,
    releaseAbort: false,
  },
  {
    method: "statAsync",
    fails: false,
    cleanupFails: true,
    pendingAbort: false,
    releaseAbort: true,
  },
] as const;
const bytes = new TextEncoder().encode("retained descriptor bytes");

function fixture(asynchronous = false, directory = false, asynchronousMetadata = false) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  let stat: ((inode: Inode) => Promise<Stat>) | undefined;
  let metadata: ((inode: Inode) => Promise<PosixMetadata>) | undefined;
  const syncStorage = asynchronousMetadata
    ? {
        ...storage,
        posix: {
          get: (inode: Inode) =>
            metadata === undefined ? storage.posix.get(inode) : metadata(inode),
          initialize: (inode: Inode, value: PosixMetadata) =>
            storage.posix.initialize(inode, value),
          create: (...args: Parameters<typeof storage.posix.create>) =>
            storage.posix.create(...args),
          chmod: (inode: Inode, mode: number) => storage.posix.chmod(inode, mode),
          chown: (...args: Parameters<typeof storage.posix.chown>) => storage.posix.chown(...args),
        },
      }
    : storage;
  const mounted = asynchronous
    ? {
        ...syncStorage,
        stat(inode: Inode) {
          return stat === undefined ? storage.stat(inode) : stat(inode);
        },
      }
    : syncStorage;
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage: mounted }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  if (directory) files.mkdir("/held");
  const fd = files.open(
    "/held",
    directory
      ? KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY
      : KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
  );
  if (!directory) files.write(fd, bytes, 0n);
  return {
    files,
    storage,
    viewStorage: syncStorage,
    fd,
    setStat(value: typeof stat) {
      stat = value;
    },
    setMetadata(value: typeof metadata) {
      metadata = value;
    },
    close() {
      files.dispose();
      database.close();
    },
  };
}

describe("asynchronous descriptor metadata lifetime", () => {
  it.each(aliases)(
    "retains an unlinked inode when the last %s descriptor closes",
    async (prefix) => {
      const test = fixture();
      const before = test.files.fstat(test.fd);
      try {
        test.files.unlink("/held");
        const stat = test.files.statAsync(`${prefix}/${test.fd}`);
        test.files.close(test.fd);
        await expect(stat).resolves.toMatchObject({
          ino: before.ino,
          size: BigInt(bytes.byteLength),
          nlink: 0n,
        });
        expect(() => test.storage.stat(before.ino)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
      } finally {
        test.close();
      }
    },
  );

  it.each(aliases)(
    "retains an unlinked directory across %s readdir and last close",
    async (prefix) => {
      const test = fixture(false, true);
      const before = test.files.fstat(test.fd);
      try {
        test.files.rmdir("/held");
        const read = test.files.readdirAsync(`${prefix}/${test.fd}`);
        test.files.close(test.fd);
        await expect(read).resolves.toEqual([]);
        expect(() => test.storage.stat(before.ino)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
      } finally {
        test.close();
      }
    },
  );

  it.each(aliases.flatMap((prefix) => statCases.map((value) => ({ prefix, ...value }))))(
    "$method keeps its selected byte view alive after the last $prefix close (failure=$fails, cleanup=$cleanupFails, abort=$pendingAbort, releaseAbort=$releaseAbort)",
    async ({ prefix, method, fails, cleanupFails, pendingAbort, releaseAbort }) => {
      const test = fixture(false, false, pendingAbort);
      let releases = 0;
      let failStat = false;
      const failure = new Error("selected view stat failed");
      const cleanupFailure = new Error("selected view cleanup failed");
      const cancellation = new Error("selected view stat cancelled");
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<PosixMetadata>();
      const metadata = test.storage.posix.get(test.files.fstat(test.fd).ino);
      test.files.close(test.fd);
      test.files.setFileBytes({
        kind: "view",
        view: {
          storage: test.viewStorage,
          completion: "sync",
          bind(inode) {
            let released = false;
            return {
              stat() {
                if (released) throw new Error("stat used a released byte view");
                if (failStat) throw failure;
                return test.storage.stat(inode);
              },
              readInto: (offset, target) => test.storage.readInto(inode, offset, target),
              write: (offset, source) => test.storage.write(inode, offset, source),
              append: (source) => test.storage.append(inode, source),
              truncate: (size) => test.storage.truncate(inode, size),
              sync: (dataOnly) => test.storage.sync(inode, dataOnly),
              release() {
                released = true;
                releases++;
                if (releaseAbort) controller.abort(cancellation);
                if (cleanupFails) throw cleanupFailure;
              },
            };
          },
        },
      });
      try {
        const fd = test.files.open("/held", KernelOpenFlags.O_RDONLY);
        const before = test.files.fstat(fd);
        if (method === "statAsync") test.files.unlink("/held");
        failStat = fails;
        if (pendingAbort)
          test.setMetadata((inode) => {
            if (inode !== before.ino) return Promise.resolve(test.storage.posix.get(inode));
            started.resolve();
            return result.promise;
          });
        const stat = test.files[method](`${prefix}/${fd}`, controller.signal);
        if (pendingAbort) await started.promise;
        test.files.close(fd);
        expect(releases).toBe(0);
        if (pendingAbort) {
          controller.abort(cancellation);
          result.resolve(metadata);
          await expect(stat).rejects.toBe(cancellation);
        } else if (releaseAbort) await expect(stat).rejects.toBe(cancellation);
        else if (fails) await expect(stat).rejects.toBe(failure);
        else if (cleanupFails) await expect(stat).rejects.toBe(cleanupFailure);
        else
          await expect(stat).resolves.toMatchObject(
            method === "statAsync"
              ? { type: "file", ino: before.ino, size: BigInt(bytes.byteLength) }
              : { type: "symlink", size: BigInt("/held".length) },
          );
        expect(releases).toBe(1);
      } finally {
        result.resolve(metadata);
        test.close();
      }
    },
  );

  it.each(
    aliases.flatMap((prefix) => ["failure", "abort"].map((outcome) => ({ prefix, outcome }))),
  )(
    "releases the last unlinked $prefix inode after a pending metadata $outcome",
    async ({ prefix, outcome }) => {
      const test = fixture(true);
      const before = test.files.fstat(test.fd);
      const metadata = test.storage.stat(before.ino);
      const controller = new AbortController();
      const failure = new Error("pending metadata stopped");
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<Stat>();
      try {
        test.files.unlink("/held");
        test.setStat((inode) => {
          if (inode !== before.ino) return Promise.resolve(test.storage.stat(inode));
          started.resolve();
          return result.promise;
        });
        const stat = test.files.statAsync(`${prefix}/${test.fd}`, controller.signal);
        await started.promise;
        test.files.close(test.fd);
        expect(test.storage.stat(before.ino).nlink).toBe(0n);
        if (outcome === "failure") result.reject(failure);
        else {
          controller.abort(failure);
          result.resolve(metadata);
        }
        await expect(stat).rejects.toBe(failure);
        expect(() => test.storage.stat(before.ino)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
      } finally {
        result.resolve(metadata);
        test.close();
      }
    },
  );
});
