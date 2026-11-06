import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

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
});
