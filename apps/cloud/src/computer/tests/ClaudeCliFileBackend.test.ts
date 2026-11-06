import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("CLI filesystem public adapter", () => {
  it("serves sync bytes from explicit prefetch while async reads use the authoritative syscall port", async () => {
    const f = await fixture();
    try {
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      expect(f.requests).toEqual([]);
      expect(() => f.fs.readFileSync("/async")).toThrow(
        expect.objectContaining({ code: "CLI_FS_NOT_PREFETCHED" }),
      );
      expect(await f.fs.promises.readFile("/async", "utf8")).toBe("remote");
      expect(f.requests.some((request) => request.name === "fd_read")).toBe(true);
      expect(() => f.fs.readFileSync("/async")).toThrow(
        expect.objectContaining({ code: "CLI_FS_NOT_PREFETCHED" }),
      );
    } finally {
      await f.close();
    }
  });

  it("projects sync writes immediately and commits exact bytes before dependent remote reads", async () => {
    const f = await fixture();
    try {
      f.fs.writeFileSync("/sync", "after");
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("after");
      await f.files.barrier();
      expect(f.canonical.readFileSync("/sync", "utf8")).toBe("after");
      expect(await f.fs.promises.readFile("/sync", "utf8")).toBe("after");
      expect(f.fs.statSync("/sync").size).toBe(5);
    } finally {
      await f.close();
    }
  });

  it("refreshes owner-assigned metadata after creation without inventing an inode", async () => {
    const f = await fixture(128, ["/sync", "/new"]);
    try {
      f.fs.writeFileSync("/new", "new bytes");
      expect(f.fs.readFileSync("/new", "utf8")).toBe("new bytes");
      expect(f.fs.statSync("/new").isFile()).toBe(true);
      expect(f.fs.statSync("/new").ino).toBe(0);
      await f.files.barrier();
      expect(f.fs.statSync("/new", { bigint: true }).ino).toBe(
        f.canonical.statSync("/new", { bigint: true }).ino,
      );
      expect(f.fs.statSync("/new").size).toBe(9);
    } finally {
      await f.close();
    }
  });

  it("makes a failed remote write sticky before later work can accept its projected content", async () => {
    const f = await fixture();
    f.failWrites();
    f.fs.writeFileSync("/sync", "uncommitted");
    await expect(f.files.barrier()).rejects.toMatchObject({ code: "EIO" });
    expect(() => f.fs.readFileSync("/sync")).toThrow();
    await expect(f.fs.promises.readFile("/sync")).rejects.toMatchObject({ code: "EIO" });
    expect(f.canonical.statSync("/sync").size).toBe(0);
    await expect(f.close()).rejects.toMatchObject({ message: "CLI filesystem cleanup failed" });
  });

  it("invalidates synchronous reads while remote work may mutate files and refreshes at completion", async () => {
    const f = await fixture();
    try {
      await f.files.beforeRemote();
      expect(() => f.fs.readFileSync("/sync")).toThrow(expect.objectContaining({ code: "ESTALE" }));
      f.canonical.writeFileSync("/sync", "changed outside CLI");
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("changed outside CLI");
    } finally {
      await f.close();
    }
  });

  it("refuses a required prefetch that exceeds the configured byte budget", async () => {
    await expect(fixture(5)).rejects.toMatchObject({ code: "CLI_FS_WORKING_SET_LIMIT" });
    await expect(fixture(8, ["/sync", "/async"])).rejects.toMatchObject({
      code: "CLI_FS_WORKING_SET_LIMIT",
    });
  });

  it("reuses owner-issued descriptors across more sync reads than the initial lease count", async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 100; index++)
        expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      await f.files.barrier();
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });

  it("finishes a view round while the CLI keeps reading synchronously", async () => {
    // Each RPC hop lets the CLI run, so a round that restarted on reads would never finish.
    let reads = 0;
    let duringRefresh = () => {};
    const f = await fixture(128, ["/sync"], false, { duringRefresh: () => duringRefresh() });
    try {
      duringRefresh = () => {
        if (reads++ < 5) expect(f.fs.readFileSync("/sync", "utf8")).toBe("written");
      };
      f.fs.writeFileSync("/sync", "written");
      const before = f.rounds;
      await f.files.barrier();
      expect(f.rounds - before).toBe(1);
      expect(f.canonical.readFileSync("/sync", "utf8")).toBe("written");

      const settled = f.rounds;
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("written");
      await f.files.barrier();
      await f.fs.promises.stat("/sync");
      expect(f.rounds).toBe(settled);
    } finally {
      await f.close();
    }
  });

  it("commits CLI output ordering without waiting for a view round", async () => {
    const f = await fixture(128, ["/sync", "/async"]);
    const held = f.holdNext("lookup");
    try {
      f.fs.writeFileSync("/sync", "changed");
      const refreshing = f.files.barrier();
      await held.entered;
      f.fs.writeFileSync("/async", "before output");
      await f.files.commit();
      expect(f.canonical.readFileSync("/async", "utf8")).toBe("before output");
      held.release();
      await refreshing;
      expect(f.fs.readFileSync("/async", "utf8")).toBe("before output");
    } finally {
      held.release();
      await f.close();
    }
  });

  it("keeps one descriptor offset across async and sync reads", async () => {
    const f = await fixture();
    try {
      const handle = await f.fs.promises.open("/sync", "r");
      try {
        const first = new Uint8Array(2);
        expect((await handle.read(first)).bytesRead).toBe(2);
        expect(new TextDecoder().decode(first)).toBe("be");
        const next = new Uint8Array(2);
        expect(f.fs.readSync(handle.fd, next)).toBe(2);
        expect(new TextDecoder().decode(next)).toBe("fo");
        const last = new Uint8Array(2);
        expect((await handle.read(last)).bytesRead).toBe(2);
        expect(new TextDecoder().decode(last)).toBe("re");
      } finally {
        await handle.close();
      }
    } finally {
      await f.close();
    }
  });

  it("leaves no projected file when sync open exhausts the owner's descriptor leases", async () => {
    const f = await fixture();
    const held: number[] = [];
    try {
      for (let index = 0; index < 32; index++) held.push(f.fs.openSync("/sync", "r"));
      expect(() => f.fs.openSync("/phantom", "w")).toThrow(
        expect.objectContaining({ code: "CLI_FS_NOT_PREFETCHED" }),
      );
      expect(f.fs.readdirSync("/")).not.toContain("phantom");
      for (const fd of held.splice(0)) f.fs.closeSync(fd);
      await f.files.barrier();
      expect(f.canonical.existsSync("/phantom")).toBe(false);
    } finally {
      for (const fd of held) f.fs.closeSync(fd);
      await f.close();
    }
  });

  it("preserves metadata on same-path rename and projects both hard-link counts", async () => {
    const f = await fixture();
    try {
      f.fs.renameSync("/sync", "/sync");
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      f.fs.linkSync("/sync", "/alias");
      expect(f.fs.statSync("/sync").nlink).toBe(2);
      expect(f.fs.statSync("/alias").nlink).toBe(2);
      await f.files.barrier();
      expect(f.canonical.statSync("/sync").nlink).toBe(2);
    } finally {
      await f.close();
    }
  });

  it("targets the open descriptor after a remote rename", async () => {
    const f = await fixture(128, ["/sync"], true);
    try {
      const fd = f.fs.openSync("/sync", "r+");
      await f.files.beforeRemote();
      f.canonical.renameSync("/sync", "/moved");
      await f.files.afterRemote();
      f.fs.fchmodSync(fd, 0o600);
      await f.files.barrier();
      expect(f.canonical.statSync("/moved").mode & 0o777).toBe(0o600);
      f.fs.closeSync(fd);
    } finally {
      await f.close();
    }
  });

  it("delivers process signals in Computer and surfaces owner rejection at the barrier", async () => {
    const f = await fixture();
    f.files.signalProcess(999_999, 0);
    await expect(f.files.barrier()).rejects.toMatchObject({ code: "ESRCH" });
    await expect(f.close()).rejects.toMatchObject({ message: "CLI filesystem cleanup failed" });
  });

  it("checks projected permissions before returning synchronous prefetched bytes", async () => {
    const f = await fixture(128, ["/sync"], true);
    try {
      f.fs.chmodSync("/sync", 0o000);
      expect(() => f.fs.readFileSync("/sync")).toThrow(expect.objectContaining({ code: "EACCES" }));
      await f.files.barrier();
      expect(() => f.canonical.readFileSync("/sync")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
    } finally {
      await f.close();
    }
  });
});
