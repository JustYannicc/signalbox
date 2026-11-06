import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";
import type {
  KernelLowerFileSystem,
  KernelLowerFileSystemEntry,
} from "../../kernel/KernelLowerFileSystem.ts";
import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const encoder = new TextEncoder();

/** A machine image layer below Computer's own files, editable to stand in for a machine. */
function lowerLayer(files: Record<string, string>) {
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
  const entry = (path: string): KernelLowerFileSystemEntry | undefined => {
    const file = bytes.get(path);
    const directory = [...bytes.keys()].some((name) =>
      name.startsWith(path === "/" ? "/" : `${path}/`),
    );
    if (file === undefined && !directory) return undefined;
    return {
      path,
      stat: {
        type: file === undefined ? "directory" : "file",
        size: BigInt(file?.byteLength ?? 0),
        nlink: file === undefined ? 2n : 1n,
        atimeNs: 11n,
        mtimeNs: 12n,
        ctimeNs: 13n,
      },
      metadata: { mode: file === undefined ? 0o755 : 0o644, uid: 1000, gid: 1000 },
    };
  };
  const children = (path: string) => {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set(
      [...bytes.keys()].flatMap((name) =>
        name.startsWith(prefix) ? [name.slice(prefix.length).split("/")[0]!] : [],
      ),
    );
    return [...names].map((name) => entry(prefix + name)!);
  };
  let handle: KernelLowerFileSystem | undefined;
  return {
    install(files: KernelFileSystem) {
      handle = files.installLowerFileSystem({
        lookup: (paths) => paths.map(entry),
        readdir: async (path) =>
          entry(path)?.stat.type === "directory" ? children(path) : undefined,
        readlink: async () => {
          throw new Error("No lower symlink");
        },
        read: async (path, offset, length) =>
          bytes.get(path)!.subarray(Number(offset), Number(offset) + length),
      });
    },
    write(path: string, text: string) {
      bytes.set(path, encoder.encode(text));
      handle!.invalidate();
    },
  };
}

describe("CLI filesystem view refresh", () => {
  it("keeps the view current across async appends without re-indexing or re-prefetching", async () => {
    const f = await fixture(128, ["/sync"]);
    try {
      const refreshes = f.refreshes;
      const bytes = f.prefetchedBytes;
      for (let index = 0; index < 8; index++) {
        await f.fs.promises.appendFile("/debug.log", `line ${index}\n`);
        expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
        expect(f.fs.statSync("/debug.log").size).toBe(7 * (index + 1));
      }
      expect(f.refreshes - refreshes).toBe(0);
      expect(f.prefetchedBytes - bytes).toBe(0);
      expect(f.canonical.readFileSync("/debug.log", "utf8")).toBe(
        Array.from({ length: 8 }, (_, index) => `line ${index}\n`).join(""),
      );
    } finally {
      await f.close();
    }
  });

  it("returns success to a sync write that lands during an async write", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const f = await fixture(128, ["/sync"], false, {
      syscall: async (request, invoke) => {
        if (hold && request.name === "fd_write") {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return invoke();
      },
    });
    let appending: Promise<void> | undefined;
    try {
      hold = true;
      appending = f.fs.promises.appendFile("/debug.log", "async");
      void appending.catch(() => {});
      await entered.promise;
      f.fs.writeFileSync("/sync", "sync write");
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("sync write");
      release.resolve();
      await appending;
      await f.files.barrier();
      expect(f.canonical.readFileSync("/sync", "utf8")).toBe("sync write");
      expect(f.canonical.readFileSync("/debug.log", "utf8")).toBe("async");
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("sync write");
    } finally {
      release.resolve();
      await Promise.allSettled([appending]);
      await f.close();
    }
  });

  it("keeps a view read going when the CLI's own writes commit during it", async () => {
    const f = await fixture(128, ["/sync", "/async"]);
    const gate = f.holdNext("metadata", "changes", "prefetch");
    let barrier: Promise<void> | undefined;
    try {
      f.fs.writeFileSync("/sync", "first");
      barrier = f.files.barrier();
      void barrier.catch(() => {});
      await gate.entered;
      f.fs.writeFileSync("/async", "second");
      await f.files.commit();
      gate.release();
      await expect(barrier).resolves.toBeUndefined();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("first");
      expect(f.fs.readFileSync("/async", "utf8")).toBe("second");
      await f.files.barrier();
      expect(f.fs.readFileSync("/async", "utf8")).toBe("second");
      expect(f.fs.statSync("/async", { bigint: true }).ino).toBe(
        f.canonical.statSync("/async", { bigint: true }).ino,
      );
    } finally {
      gate.release();
      await Promise.allSettled([barrier]);
      await f.close();
    }
  });

  it("re-reads only the paths a Computer child changed", async () => {
    const f = await fixture(256, ["/sync", "/big", "/made/file"], false, {
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    try {
      expect(f.fs.readFileSync("/big", "utf8")).toHaveLength(100);
      const refreshes = f.refreshes;
      const bytes = f.prefetchedBytes;
      // The bracket the CLI puts around every process it runs in Computer.
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      f.canonical.mkdirSync("/made");
      f.canonical.writeFileSync("/made/file", "new");
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("child wrote");
      expect(f.fs.readdirSync("/made")).toEqual(["file"]);
      expect(f.fs.readFileSync("/made/file", "utf8")).toBe("new");
      expect(f.fs.readFileSync("/big", "utf8")).toHaveLength(100);
      expect(f.refreshes - refreshes).toBe(0);
      expect(f.prefetchedBytes - bytes).toBe("child wrote".length + "new".length);
    } finally {
      await f.close();
    }
  });

  it("re-indexes metadata but keeps unchanged bytes when Computer can't list its changes", async () => {
    const f = await fixture(256, ["/sync", "/big"], false, {
      changeFeed: false,
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    try {
      const refreshes = f.refreshes;
      const bytes = f.prefetchedBytes;
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "child wrote");
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("child wrote");
      expect(f.fs.readFileSync("/big", "utf8")).toHaveLength(100);
      expect(f.refreshes - refreshes).toBeGreaterThan(0);
      expect(f.prefetchedBytes - bytes).toBe("child wrote".length);
    } finally {
      await f.close();
    }
  });

  it("does not move the filesystem revision for unrelated SQLite writes", async () => {
    const f = await fixture();
    try {
      const revision = f.revision();
      const rounds = f.rounds;
      f.sql.exec("CREATE TABLE IF NOT EXISTS unrelated_journal (value TEXT)");
      f.sql.exec("INSERT INTO unrelated_journal VALUES ('stdout bytes')");
      expect(f.revision()).toBe(revision);
      await f.files.barrier();
      expect(f.rounds).toBe(rounds);
      f.canonical.writeFileSync("/sync", "changed");
      expect(f.revision()).toBeGreaterThan(revision);
    } finally {
      await f.close();
    }
  });

  it("keeps the CLI's later write to a new file when a round refreshes its descriptor", async () => {
    let holdWrite = false;
    let releaseWrite: (() => void) | undefined;
    const f = await fixture(128, ["/sync"], false, {
      seed(fs) {
        fs.mkdirSync("/w");
      },
      syscall: async (request, invoke) => {
        if (holdWrite && request.name === "fd_write") {
          holdWrite = false;
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        }
        return invoke();
      },
      // The second write stays uncommitted until the round has refreshed descriptors.
      onLeaseRefill: () => releaseWrite?.(),
    });
    let stat: Promise<unknown> | undefined;
    try {
      const fd = f.fs.openSync("/w/new", "w+");
      f.fs.writeSync(fd, "A");
      const gate = f.holdNext("lookup");
      stat = f.fs.promises.stat("/sync");
      void stat.catch(() => {});
      await gate.entered;
      holdWrite = true;
      f.fs.writeSync(fd, "BB");
      gate.release();
      await stat;
      expect(f.fs.readFileSync("/w/new", "utf8")).toBe("ABB");
      f.fs.closeSync(fd);
      await f.files.barrier();
      expect(f.canonical.readFileSync("/w/new", "utf8")).toBe("ABB");
      expect(f.fs.readFileSync("/w/new", "utf8")).toBe("ABB");
    } finally {
      releaseWrite?.();
      await Promise.allSettled([stat]);
      await f.close();
    }
  });

  it("re-reads lower files a Computer child copied up into new inodes", async () => {
    const lower = lowerLayer({ "/etc/foo": "lower", "/etc/sub/bar": "bar" });
    const f = await fixture(256, ["/sync", "/etc/foo", "/etc/sub/bar"], true, {
      seed: (_fs, files) => lower.install(files),
    });
    try {
      expect(f.fs.readFileSync("/etc/foo", "utf8")).toBe("lower");
      const refreshes = f.refreshes;
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/etc/foo", "copied up");
      f.canonical.writeFileSync("/etc/sub/bar", "bar, edited");
      f.canonical.writeFileSync("/etc/sub/new", "n");
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/etc/foo", "utf8")).toBe("copied up");
      expect(f.fs.statSync("/etc/foo", { bigint: true }).ino).toBe(
        f.canonical.statSync("/etc/foo", { bigint: true }).ino,
      );
      expect(f.fs.readFileSync("/etc/sub/bar", "utf8")).toBe("bar, edited");
      expect(f.fs.readdirSync("/etc/sub").sort()).toEqual(["bar", "new"]);
      expect(f.refreshes - refreshes).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("re-indexes while a machine command runs, so its lower writes are seen", async () => {
    const lower = lowerLayer({ "/etc/tool.conf": "v1" });
    let machine = { machine: 0, machineRunning: false };
    const f = await fixture(256, ["/sync", "/etc/tool.conf"], true, {
      seed: (_fs, files) => lower.install(files),
      machine: () => machine,
    });
    try {
      // A machine command the CLI did not start is running and writes the lower layer.
      machine = { machine: 1, machineRunning: true };
      await f.fs.promises.stat("/sync");
      lower.write("/etc/tool.conf", "version 2");
      f.fs.writeFileSync("/sync", "own write");
      await f.fs.promises.stat("/sync");
      expect(f.fs.readFileSync("/etc/tool.conf", "utf8")).toBe("version 2");
      machine = { machine: 2, machineRunning: false };
      lower.write("/etc/tool.conf", "version three");
      await f.fs.promises.stat("/sync");
      expect(f.fs.readFileSync("/etc/tool.conf", "utf8")).toBe("version three");
    } finally {
      await f.close();
    }
  });

  it("keeps an async rename's success when a chmod lands while its target is prefetched", async () => {
    const f = await fixture(128, ["/sync", "/async"], true);
    const gate = f.holdNext("prefetch");
    let renaming: Promise<void> | undefined;
    try {
      renaming = f.fs.promises.rename("/async", "/sync");
      void renaming.catch(() => {});
      await gate.entered;
      f.fs.chmodSync("/sync", 0o600);
      gate.release();
      await expect(renaming).resolves.toBeUndefined();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("remote");
      await f.files.barrier();
      expect(f.canonical.statSync("/sync").mode & 0o777).toBe(0o600);
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("remote");
    } finally {
      gate.release();
      await Promise.allSettled([renaming]);
      await f.close();
    }
  });

  it("drops bytes Computer rewrote at the same size when it can't list its changes", async () => {
    const f = await fixture(256, ["/sync", "/big"], false, {
      changeFeed: false,
      seed(fs) {
        fs.writeFileSync("/big", "b".repeat(100));
      },
    });
    try {
      const bytes = f.prefetchedBytes;
      await f.files.beforeRemote();
      // Same inode, size and (in this fixture) mtime: only the bytes differ.
      f.canonical.writeFileSync("/big", "c".repeat(100));
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/big", "utf8")).toBe("c".repeat(100));
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      expect(f.prefetchedBytes - bytes).toBe(100);
    } finally {
      await f.close();
    }
  });
});
