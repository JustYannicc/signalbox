import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const text = new TextDecoder();

describe("CLI filesystem coherence", () => {
  it("follows symlinks before parent components for sync and async paths", async () => {
    const f = await fixture(128, ["/work/wanted", "/work/actual/wanted"], false, {
      seed(fs) {
        fs.mkdirSync("/work/actual/nested", { recursive: true });
        fs.writeFileSync("/work/wanted", "lexical");
        fs.writeFileSync("/work/actual/wanted", "physical");
        fs.symlinkSync("actual/nested", "/work/link");
      },
    });
    try {
      const path = "/work/link/../wanted";
      expect(f.fs.readFileSync(path, "utf8")).toBe("physical");
      expect(await f.fs.promises.readFile(path, "utf8")).toBe("physical");
      f.fs.mkdirSync("/work/link/../created");
      await f.files.barrier();
      expect(f.canonical.existsSync("/work/actual/created")).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("does not commit a sync mutation rejected by the path budget", async () => {
    const f = await fixture();
    try {
      const path = "/" + "x".repeat(256);
      expect(() => f.fs.mkdirSync(path)).toThrow();
      await f.files.barrier();
      expect(f.canonical.existsSync(path)).toBe(false);
      expect(f.fs.readdirSync("/")).not.toContain(path.slice(1));
    } finally {
      await f.close();
    }
  });

  it("keeps an open inode readable after unlink and releases its retained bytes on close", async () => {
    const f = await fixture(128, ["/sync", "/async"]);
    try {
      const fd = f.fs.openSync("/sync", "r+");
      f.fs.unlinkSync("/sync");
      expect(f.fs.existsSync("/sync")).toBe(false);
      const bytes = new Uint8Array(6);
      expect(f.fs.readSync(fd, bytes, 0, 6, 0)).toBe(6);
      expect(text.decode(bytes)).toBe("before");
      await f.files.barrier();
      expect(f.canonical.existsSync("/sync")).toBe(false);
      expect(f.fs.fstatSync(fd).nlink).toBe(0);
      expect(f.fs.readSync(fd, bytes, 0, 6, 0)).toBe(6);
      expect(text.decode(bytes)).toBe("before");
      f.fs.writeSync(fd, new TextEncoder().encode("AFTER!"), 0, 6, 0);
      await f.files.barrier();
      expect(f.fs.readSync(fd, bytes, 0, 6, 0)).toBe(6);
      expect(text.decode(bytes)).toBe("AFTER!");
      f.fs.closeSync(fd);
      await f.files.barrier();
      expect(f.fs.readFileSync("/async", "utf8")).toBe("remote");
    } finally {
      await f.close();
    }
  });

  it("renames cached bytes while keeping descriptors bound to their original inodes", async () => {
    const f = await fixture(128, ["/sync", "/async"]);
    try {
      const source = f.fs.openSync("/sync", "r");
      const destination = f.fs.openSync("/async", "r");
      f.fs.renameSync("/sync", "/async");
      expect(f.fs.readFileSync("/async", "utf8")).toBe("before");
      const bytes = new Uint8Array(6);
      expect(f.fs.readSync(source, bytes, 0, 6, 0)).toBe(6);
      expect(text.decode(bytes)).toBe("before");
      expect(f.fs.readSync(destination, bytes, 0, 6, 0)).toBe(6);
      expect(text.decode(bytes)).toBe("remote");
      await f.files.barrier();
      expect(f.fs.readFileSync("/async", "utf8")).toBe("before");
      expect(f.fs.readSync(destination, bytes, 0, 6, 0)).toBe(6);
      expect(text.decode(bytes)).toBe("remote");
      f.fs.closeSync(source);
      f.fs.closeSync(destination);
    } finally {
      await f.close();
    }
  });

  it("refreshes one remote mutation before admitting another during prefetch", async () => {
    const f = await fixture();
    const gate = f.holdNext("prefetch");
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "first");
      first = f.files.afterRemote();
      void first.catch(() => {});
      await gate.entered;
      second = (async () => {
        await f.files.beforeRemote();
        f.canonical.writeFileSync("/sync", "second");
        await f.files.afterRemote();
      })();
      void second.catch(() => {});
      await f.fs.promises.stat("/async");
      gate.release();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("second");
      await f.files.barrier();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("second");
    } finally {
      gate.release();
      await Promise.allSettled([first, second]);
      await f.close();
    }
  });

  it("supports POSIX stat and chown over the normal lower overlay", async () => {
    const f = await fixture(128, ["/sync"], true, {
      seed(_fs, files) {
        files.installLowerFileSystem({
          lookup: (paths) => paths.map(() => undefined),
          readdir: async () => undefined,
          readlink: async () => {
            throw new Error("No lower symlink");
          },
          read: async () => {
            throw new Error("No lower file");
          },
        });
      },
    });
    try {
      expect((await f.fs.promises.stat("/sync")).uid).toBe(1000);
      await f.fs.promises.chown("/sync", 1000, 1000);
      expect((await f.fs.promises.stat("/sync")).uid).toBe(1000);
    } finally {
      await f.close();
    }
  });
  it("reports a pending sync creation as existing before its write barrier", async () => {
    const f = await fixture();
    try {
      f.fs.writeFileSync("/new", "created");
      expect(f.fs.existsSync("/new")).toBe(true);
      expect(f.fs.statSync("/new").isFile()).toBe(true);
      expect(f.fs.statSync("/new").size).toBe(7);
      expect(f.fs.statSync("/new").ino).toBe(0);
      await f.files.barrier();
      expect(f.fs.statSync("/new").ino).toBeGreaterThan(0);
      await f.files.barrier();
      expect(f.canonical.readFileSync("/new", "utf8")).toBe("created");
    } finally {
      await f.close();
    }
  });

  it("rejects a public async close of the private path root descriptor", async () => {
    const f = await fixture();
    try {
      const close = new Promise<void>((resolve, reject) => {
        f.fs.close(f.rootDescriptor, (error) => (error ? reject(error) : resolve()));
      });
      const closed = await close.then(
        () => "closed",
        (error: unknown) => Reflect.get(Object(error), "code"),
      );
      const stat = await f.fs.promises.stat("/sync").then(
        (value) => value.size,
        (error: unknown) => Reflect.get(Object(error), "code"),
      );
      expect({ rootDescriptor: f.rootDescriptor, closed, stat }).toEqual({
        rootDescriptor: f.rootDescriptor,
        closed: "EBADF",
        stat: 6,
      });
    } finally {
      await f.close();
    }
  });
});
