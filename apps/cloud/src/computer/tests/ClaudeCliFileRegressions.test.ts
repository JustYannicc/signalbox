import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";
import type {
  KernelSyscallRequest,
  KernelSyscallResponse,
} from "../../kernel/KernelSyscallPort.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function opened(request: KernelSyscallRequest, response: KernelSyscallResponse) {
  if (request.name !== "path_open" || response.kind !== "return" || response.value !== 0)
    return undefined;
  const pointer = Number(request.args[8]);
  const region = response.regions.find(
    (item) => pointer >= item.pointer && pointer + 4 <= item.pointer + item.bytes.byteLength,
  )!;
  return new DataView(
    region.bytes.buffer,
    region.bytes.byteOffset + pointer - region.pointer,
    4,
  ).getUint32(0, true);
}

describe("CLI filesystem accepted regressions", () => {
  it("closes an open cancelled during its later descriptor metadata request", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let allocated: number | undefined;
    const f = await fixture(128, ["/sync"], false, {
      syscall: async (request, invoke) => {
        const result = await invoke();
        allocated = opened(request, result) ?? allocated;
        if (request.name === "fd_filestat_get" && Number(request.args[0]) === allocated) {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    });
    try {
      const reading = f.fs.promises.readFile("/sync", { signal: controller.signal });
      const rejected = expect(reading).rejects.toBeDefined();
      await entered.promise;
      controller.abort(new Error("stop after open response"));
      release.resolve();
      await rejected;
      expect(allocated).toBeDefined();
      expect(() => f.canonical.fstatSync(allocated!)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(
        f.requests.some(
          (request) => request.name === "fd_close" && Number(request.args[0]) === allocated,
        ),
      ).toBe(true);
      expect(await f.fs.promises.readFile("/sync", "utf8")).toBe("before");
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("queues write-only append and truncate without prefetched bytes", async () => {
    const f = await fixture(16, ["/sync"]);
    try {
      const fd = f.fs.openSync("/async", "a");
      expect(f.fs.writeSync(fd, "!")).toBe(1);
      expect(f.fs.writeSync(fd, "?")).toBe(1);
      expect(f.fs.statSync("/async").size).toBe(8);
      f.fs.ftruncateSync(fd, 5);
      expect(f.fs.fstatSync(fd).size).toBe(5);
      expect(f.fs.writeSync(fd, "Z")).toBe(1);
      expect(f.fs.fstatSync(fd).size).toBe(6);
      expect(() => f.fs.readFileSync("/async", "utf8")).toThrow(
        expect.objectContaining({ code: "EIO" }),
      );
      f.fs.closeSync(fd);
      await f.files.barrier();
      expect(f.canonical.readFileSync("/async", "utf8")).toBe("remotZ");
      expect(await f.fs.promises.readFile("/async", "utf8")).toBe("remotZ");
    } finally {
      await f.close();
    }
  });

  it("keeps same-inode hardlink rename a no-op before and after the barrier", async () => {
    const f = await fixture();
    try {
      f.fs.linkSync("/sync", "/alias");
      f.fs.renameSync("/sync", "/alias");
      expect(f.fs.existsSync("/sync")).toBe(true);
      expect(f.fs.statSync("/sync").ino).toBe(f.fs.statSync("/alias").ino);
      expect(f.fs.statSync("/sync").nlink).toBe(2);
      await f.files.barrier();
      expect(f.canonical.statSync("/sync").ino).toBe(f.canonical.statSync("/alias").ino);
      expect(f.fs.statSync("/sync").nlink).toBe(f.canonical.statSync("/sync").nlink);
    } finally {
      await f.close();
    }
  });

  it("projects replaced-inode nlink across every remaining name and open descriptor", async () => {
    const f = await fixture(128, ["/sync", "/async", "/other"], false, {
      seed(fs) {
        fs.linkSync("/async", "/other");
      },
    });
    try {
      const replaced = f.fs.openSync("/async", "r");
      const alias = f.fs.openSync("/other", "r");
      f.fs.renameSync("/sync", "/async");
      expect(f.fs.statSync("/other").nlink).toBe(1);
      expect(f.fs.fstatSync(replaced).nlink).toBe(1);
      expect(f.fs.fstatSync(alias).nlink).toBe(1);
      expect(f.fs.readFileSync("/async", "utf8")).toBe("before");
      await f.files.barrier();
      expect(f.canonical.statSync("/other").nlink).toBe(1);
      expect(f.fs.fstatSync(alias).nlink).toBe(1);
      f.fs.closeSync(replaced);
      f.fs.closeSync(alias);
    } finally {
      await f.close();
    }
  });

  it("does not equate unrelated pending inode zero values during rename", async () => {
    const f = await fixture();
    try {
      f.fs.writeFileSync("/first", "one");
      f.fs.writeFileSync("/second", "two");
      f.fs.renameSync("/first", "/second");
      expect(f.fs.existsSync("/first")).toBe(false);
      expect(f.fs.readFileSync("/second", "utf8")).toBe("one");
      await f.files.barrier();
      expect(f.canonical.readFileSync("/second", "utf8")).toBe("one");
    } finally {
      await f.close();
    }
  });

  it("rejects actual private and unused reserved descriptor path aliases", async () => {
    const f = await fixture();
    try {
      for (const fd of [f.rootDescriptor, f.privateLease]) {
        for (const prefix of ["/proc/self/fd", "/dev/fd"]) {
          await expect(f.fs.promises.readlink(`${prefix}/${fd}`)).rejects.toMatchObject({
            code: "EBADF",
          });
          await expect(f.fs.promises.stat(`${prefix}/${fd}/sync`)).rejects.toMatchObject({
            code: "EBADF",
          });
        }
      }
      expect(await f.fs.promises.readFile("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });

  it("preserves allocated public descriptor aliases, stdio, paths and ordinary symlinks", async () => {
    const f = await fixture(128, ["/sync"], false, {
      seed(fs) {
        fs.symlinkSync("/sync", "/normal-link");
      },
    });
    try {
      const file = await f.fs.promises.open("/sync", "r");
      for (const prefix of ["/proc/self/fd", "/dev/fd"]) {
        expect(await f.fs.promises.readlink(`${prefix}/${file.fd}`)).toBe("/sync");
        expect(await f.fs.promises.stat(`${prefix}/${file.fd}`)).toMatchObject({ size: 6 });
      }
      await expect(f.fs.promises.readlink("/dev/fd/1")).rejects.toMatchObject({
        code: "ENOTSUP",
        errno: -95,
        syscall: "readlink",
        path: "/dev/fd/1",
      });
      expect(await f.fs.promises.readlink("/normal-link")).toBe("/sync");
      expect(await f.fs.promises.readFile("/normal-link", "utf8")).toBe("before");
      await file.close();
    } finally {
      await f.close();
    }
  });
});
