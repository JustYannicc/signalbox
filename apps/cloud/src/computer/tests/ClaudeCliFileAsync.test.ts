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

describe("CLI filesystem async contracts", () => {
  it("pins prefetched bytes for an asynchronously opened readable descriptor", async () => {
    const f = await fixture(16, ["/sync", "/async"]);
    try {
      const file = await f.fs.promises.open("/sync", "r");
      expect(() => f.fs.writeFileSync("/async", "AFTER!")).toThrow(
        expect.objectContaining({ code: "CLI_FS_WORKING_SET_LIMIT" }),
      );
      const bytes = new Uint8Array(6);
      expect(f.fs.readSync(file.fd, bytes, 0, 6, 0)).toBe(6);
      expect(new TextDecoder().decode(bytes)).toBe("before");
      await file.close();
    } finally {
      await f.close();
    }
  });

  it("closes a temporary descriptor when readFile is cancelled during its read", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let fd: number | undefined;
    const f = await fixture(128, ["/sync"], false, {
      syscall: async (request, invoke) => {
        if (request.name === "fd_read") {
          entered.resolve();
          await release.promise;
        }
        const result = await invoke();
        fd = opened(request, result) ?? fd;
        return result;
      },
    });
    try {
      const reading = f.fs.promises.readFile("/sync", { signal: controller.signal });
      const rejected = expect(reading).rejects.toBeDefined();
      await entered.promise;
      controller.abort(new Error("stop read"));
      release.resolve();
      await rejected;
      expect(
        f.requests.some((request) => request.name === "fd_close" && Number(request.args[0]) === fd),
      ).toBe(true);
      await expect(f.fs.promises.stat("/async")).resolves.toMatchObject({ size: 6 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("closes successful opens when cancellation wins the return boundary", async () => {
    let controller: AbortController | undefined;
    const allocated: number[] = [];
    const f = await fixture(128, ["/sync"], false, {
      syscall: async (request, invoke) => {
        const result = await invoke();
        const fd = opened(request, result);
        if (controller !== undefined && fd !== undefined) {
          allocated.push(fd);
          controller.abort(new Error("stop open result"));
        }
        return result;
      },
    });
    try {
      for (let index = 0; index < 4; index++) {
        controller = new AbortController();
        await expect(
          f.fs.promises.readFile("/sync", { signal: controller.signal }),
        ).rejects.toBeDefined();
      }
      controller = undefined;
      expect(allocated).toHaveLength(4);
      expect(
        f.requests.filter(
          (request) => request.name === "fd_close" && allocated.includes(Number(request.args[0])),
        ),
      ).toHaveLength(4);
      expect(await f.fs.promises.readFile("/sync", "utf8")).toBe("before");
    } finally {
      controller = undefined;
      await f.close();
    }
  });

  it("reads asynchronous directory entry types from Computer after external changes", async () => {
    const f = await fixture();
    try {
      f.canonical.mkdirSync("/new-dir");
      const dir = await f.fs.promises.opendir("/");
      const entries = [];
      for await (const entry of dir) entries.push(entry);
      expect(entries.find((entry) => entry.name === "new-dir")?.isDirectory()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("links the symlink inode through both public sync and async APIs", async () => {
    const f = await fixture(128, ["/sync"], false, {
      seed(fs) {
        fs.symlinkSync("/sync", "/link");
      },
    });
    try {
      await f.fs.promises.link("/link", "/async-link");
      expect((await f.fs.promises.lstat("/async-link")).isSymbolicLink()).toBe(true);
      f.fs.linkSync("/link", "/sync-link");
      expect(f.fs.lstatSync("/sync-link").isSymbolicLink()).toBe(true);
      await f.files.barrier();
      expect(f.canonical.lstatSync("/sync-link").ino).toBe(f.canonical.lstatSync("/link").ino);
      expect(f.canonical.lstatSync("/async-link").ino).toBe(f.canonical.lstatSync("/link").ino);
    } finally {
      await f.close();
    }
  });

  it("keeps watch and watchFile alive across transient revision invalidation", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const changes: unknown[] = [],
      statChanges: unknown[] = [],
      errors: unknown[] = [],
      stops: unknown[] = [];
    const watch = f.fs.watch("/sync", (...args) => changes.push(args));
    watch.on("error", (error) => errors.push(error));
    const statWatch = f.fs.watchFile("/sync", { interval: 100 }, (...args) =>
      statChanges.push(args),
    );
    statWatch.on("error", (error) => errors.push(error));
    statWatch.on("stop", () => stops.push("stop"));
    try {
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/sync", "changed");
      await vi.advanceTimersByTimeAsync(101);
      expect(errors).toEqual([]);
      expect(stops).toEqual([]);
      await f.files.afterRemote();
      await vi.advanceTimersByTimeAsync(101);
      expect(changes).toHaveLength(1);
      expect(statChanges).toHaveLength(1);
    } finally {
      watch.close();
      f.fs.unwatchFile("/sync");
      await f.close();
      vi.useRealTimers();
    }
  });
});
