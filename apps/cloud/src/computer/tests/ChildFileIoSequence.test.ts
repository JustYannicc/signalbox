import { describe, expect, it, vi } from "vite-plus/test";
import { KernelOpenFlags, type KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import type {
  KernelSyscallRequest,
  KernelSyscallResponse,
} from "../../kernel/KernelSyscallPort.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const SIZE = 2 * 1024 * 1024;
const DATA = 1024;

function guest(filesystem: KernelFileSystem, name: string, size = SIZE) {
  const controller = new AbortController();
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: controller.signal,
  });
  const positioned = name === "fd_pwrite";
  const module = wasmImportReactor(
    "wasi_snapshot_preview1",
    name,
    positioned ? ["i32", "i32", "i32", "i64", "i32"] : ["i32", "i32", "i32", "i32"],
    ["i32"],
  );
  let after: (
    request: KernelSyscallRequest,
    response: KernelSyscallResponse,
  ) => Promise<void> = async () => {};
  let entered: () => void = () => {};
  let calls = 0;
  const child = createChildWasi({
    module,
    args: [],
    env: {},
    syscalls: {
      async call(request) {
        entered();
        calls++;
        const response = await host.call(structuredClone(request));
        await after(request, response);
        return structuredClone(response);
      },
    },
  });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  const memory = instance.exports.memory as WebAssembly.Memory;
  memory.grow(Math.ceil(size / 65536));
  const view = new DataView(memory.buffer);
  view.setUint32(32, DATA, true);
  view.setUint32(36, size, true);
  return {
    controller,
    host,
    bytes: new Uint8Array(memory.buffer, DATA, size),
    view,
    get calls() {
      return calls;
    },
    after(fn: typeof after) {
      after = fn;
    },
    entered(fn: typeof entered) {
      entered = fn;
    },
    run: (fd: number, position = 0n) =>
      positioned
        ? child.run(instance.exports.run!, fd, 32, 1, position, 16)
        : child.run(instance.exports.run!, fd, 32, 1, 16),
    close() {
      host.close();
    },
  };
}

function readFile(filesystem: KernelFileSystem, path: string, size: number) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  const bytes = new Uint8Array(size);
  try {
    expect(filesystem.read(fd, bytes, 0n)).toBe(size);
    return bytes;
  } finally {
    filesystem.close(fd);
  }
}

describe("one guest file operation across child transfers", () => {
  it("keeps regular-file reads on a shared offset contiguous", async () => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open("/input", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
    const input = Uint8Array.from({ length: 2 * SIZE }, (_, index) => Math.floor(index / 4096));
    fixture.filesystem.write(fd, input, 0n);
    const a = guest(fixture.filesystem, "fd_read");
    const b = guest(fixture.filesystem, "fd_read");
    const first = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const competing = Promise.withResolvers<void>();
    a.after(async (request) => {
      if (request.transferOffset === 0) {
        first.resolve();
        await resume.promise;
      }
    });
    b.entered(() => competing.resolve());
    try {
      const readingA = a.run(fd);
      await first.promise;
      const readingB = b.run(fd);
      await competing.promise;
      resume.resolve();
      expect(await readingA).toBe(0);
      expect(await readingB).toBe(0);
      expect(a.bytes).toEqual(input.subarray(0, SIZE));
      expect(b.bytes).toEqual(input.subarray(SIZE));
    } finally {
      resume.resolve();
      a.close();
      b.close();
      fixture.close();
    }
  });

  it("serializes pwrite windows on the same inode", async () => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open("/output", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
    const otherFd = fixture.filesystem.open("/output", KernelOpenFlags.O_RDWR);
    const a = guest(fixture.filesystem, "fd_pwrite");
    const b = guest(fixture.filesystem, "fd_pwrite");
    a.bytes.fill(0x41);
    b.bytes.fill(0x42);
    const first = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const competing = Promise.withResolvers<void>();
    a.after(async (request) => {
      if (request.transferOffset === 0) {
        first.resolve();
        await resume.promise;
      }
    });
    b.entered(() => competing.resolve());
    try {
      const writingA = a.run(fd);
      await first.promise;
      const writingB = b.run(otherFd, 4096n);
      await competing.promise;
      resume.resolve();
      expect(await writingA).toBe(0);
      expect(await writingB).toBe(0);
      const expected = new Uint8Array(SIZE + 4096).fill(0x42);
      expected.fill(0x41, 0, 4096);
      expect(readFile(fixture.filesystem, "/output", expected.length)).toEqual(expected);
    } finally {
      resume.resolve();
      a.close();
      b.close();
      fixture.close();
    }
  });

  it.each(["abort", "close"] as const)(
    "releases a writer's lock after %s between transfers",
    async (ending) => {
      const fixture = createTestFilesystem();
      const fd = fixture.filesystem.open(
        "/output",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
      );
      const otherFd = fixture.filesystem.open(
        "/output",
        KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
      );
      const a = guest(fixture.filesystem, "fd_write");
      const b = guest(fixture.filesystem, "fd_write", 3);
      a.bytes.fill(0x41);
      b.bytes.fill(0x42);
      const first = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      a.after(async (request) => {
        if (request.transferOffset === 0) {
          first.resolve();
          await resume.promise;
        }
      });
      const writingA = a.run(fd);
      try {
        await first.promise;
        if (ending === "abort") a.controller.abort();
        else a.close();
        expect(await b.run(otherFd)).toBe(0);
        resume.resolve();
        expect(await writingA).toBe(0);
        const prefix = a.view.getUint32(16, true);
        expect(prefix).toBeGreaterThan(0);
        expect(prefix).toBeLessThan(SIZE);
        const result = readFile(fixture.filesystem, "/output", prefix + 3);
        expect(result.subarray(0, prefix).every((byte) => byte === 0x41)).toBe(true);
        expect(result.subarray(prefix)).toEqual(b.bytes);
      } finally {
        resume.resolve();
        await writingA.catch(() => {});
        a.close();
        b.close();
        fixture.close();
      }
    },
  );

  it("fills a regular-file read when its storage returns smaller batches", async () => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open(
      "/batched",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
    );
    const input = Uint8Array.from({ length: 8192 }, (_, index) => index % 251);
    fixture.filesystem.write(fd, input, 0n);
    const storage = fixture.filesystem.descriptors.get(fd).mount!.storage;
    const read = storage.readInto.bind(storage);
    const spy = vi.spyOn(storage, "readInto").mockImplementation((inode, offset, target) => {
      const count = read(inode, offset, target.subarray(0, 300));
      if (typeof count !== "number") throw new Error("This fixture requires synchronous storage");
      return count;
    });
    const child = guest(fixture.filesystem, "fd_read", input.length);
    try {
      expect(await child.run(fd)).toBe(0);
      expect(child.view.getUint32(16, true)).toBe(input.length);
      expect(child.bytes).toEqual(input);
    } finally {
      child.close();
      spy.mockRestore();
      fixture.close();
    }
  });

  it("stops a short regular-file read at EOF without an empty continuation", async () => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open("/small", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
    fixture.filesystem.write(fd, new Uint8Array(100).fill(0x5a), 0n);
    const child = guest(fixture.filesystem, "fd_read", 8192);
    try {
      expect(await child.run(fd)).toBe(0);
      expect(child.view.getUint32(16, true)).toBe(100);
      expect(child.bytes.subarray(0, 100).every((byte) => byte === 0x5a)).toBe(true);
      expect(child.calls).toBe(1);
    } finally {
      child.close();
      fixture.close();
    }
  });
});
