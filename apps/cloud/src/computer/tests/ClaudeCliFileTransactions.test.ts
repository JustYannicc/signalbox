import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("CLI filesystem transactions", () => {
  it("validates all link projections before changing counts or enqueueing a physical link", async () => {
    const f = await fixture(128, ["/sync"], false, { metadataLimit: 3 });
    try {
      expect(() => f.fs.linkSync("/sync", "/alias")).toThrow();
      expect(f.fs.statSync("/sync").nlink).toBe(1);
      expect(f.fs.existsSync("/alias")).toBe(false);
      await f.files.barrier();
      expect(f.canonical.statSync("/sync").nlink).toBe(1);
      expect(f.canonical.existsSync("/alias")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("moves a name at metadata capacity without needing an extra metadata slot", async () => {
    const f = await fixture(128, ["/sync"], false, { metadataLimit: 3 });
    try {
      f.fs.renameSync("/sync", "/moved");
      expect(f.fs.readFileSync("/moved", "utf8")).toBe("before");
      await f.files.barrier();
      expect(f.fs.readFileSync("/moved", "utf8")).toBe("before");
      expect(f.canonical.existsSync("/sync")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("rejects an entire directory rename when a descendant exceeds the path bound", async () => {
    const child = "c".repeat(30),
      destination = "/" + "d".repeat(240);
    const f = await fixture(128, ["/src/" + child], false, {
      seed(fs) {
        fs.mkdirSync("/src");
        fs.writeFileSync("/src/" + child, "kept");
      },
    });
    try {
      expect(() => f.fs.renameSync("/src", destination)).toThrow();
      expect(f.fs.readFileSync("/src/" + child, "utf8")).toBe("kept");
      expect(f.fs.existsSync(destination)).toBe(false);
      await f.files.barrier();
      expect(f.canonical.existsSync("/src/" + child)).toBe(true);
      expect(f.canonical.existsSync(destination)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("refuses internal root and reserved lease fds through public APIs without poisoning later calls", async () => {
    const f = await fixture();
    try {
      for (const fd of [f.rootDescriptor, f.privateLease]) {
        await expect(
          new Promise((resolve, reject) =>
            f.fs.close(fd, (error) => (error ? reject(error) : resolve(undefined))),
          ),
        ).rejects.toMatchObject({ code: "EBADF" });
        await expect(
          new Promise((resolve, reject) =>
            f.fs.read(fd, new Uint8Array(1), 0, 1, 0, (error) =>
              error ? reject(error) : resolve(undefined),
            ),
          ),
        ).rejects.toMatchObject({ code: "EBADF" });
      }
      expect(await f.fs.promises.readFile("/sync", "utf8")).toBe("before");
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });

  it("does not publish writes queued during reconciliation before they physically commit", async () => {
    vi.useFakeTimers();
    const writeEntered = Promise.withResolvers<void>(),
      releaseWrite = Promise.withResolvers<void>();
    let holdWrite = false,
      committed = false;
    const f = await fixture(128, ["/sync"], true, {
      syscall: async (request, invoke) => {
        if (holdWrite && request.name === "fd_write") {
          writeEntered.resolve();
          await releaseWrite.promise;
        }
        const result = await invoke();
        if (holdWrite && request.name === "fd_write") committed = true;
        return result;
      },
    });
    const gate = f.holdNextPrefetch();
    let result: string | undefined;
    let reading: Promise<string> | undefined;
    try {
      f.fs.chmodSync("/sync", 0o600);
      reading = f.files.barrier().then(() => {
        const value = String(f.canonical.readFileSync("/new", "utf8"));
        result = value;
        return value;
      });
      void reading.catch(() => {});
      await gate.entered;
      holdWrite = true;
      f.fs.writeFileSync("/new", "created");
      await writeEntered.promise;
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(committed).toBe(false);
      expect(result).toBeUndefined();
      releaseWrite.resolve();
      expect(await reading).toBe("created");
      expect(committed).toBe(true);
      expect(f.fs.readFileSync("/new", "utf8")).toBe("created");
    } finally {
      gate.release();
      releaseWrite.resolve();
      await Promise.allSettled([reading]);
      await f.close();
      vi.useRealTimers();
    }
  });
});
