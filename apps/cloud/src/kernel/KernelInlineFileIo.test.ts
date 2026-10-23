import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import type { KernelSyscallResponse } from "./KernelSyscallPort.ts";
import { kernelFileWriteLock } from "./KernelIoLock.ts";
import {
  SIZE,
  createTestFilesystem,
  guest,
  readFile,
  inline,
} from "./tests/inlineFileIoFixture.ts";

describe("inline file operations during child continuation I/O", () => {
  it.each(["fd_write", "fd_pwrite"])("does not trap or wedge an inline %s", async (name) => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open(
      "/log",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
    );
    const other = fixture.filesystem.open(
      "/log",
      KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
    );
    const a = guest(fixture.filesystem, "fd_write");
    const b = guest(fixture.filesystem, "fd_write", 3);
    a.bytes.fill(0x41);
    b.bytes.fill(0x42);
    const sync = inline(fixture.filesystem);
    let called = false;
    a.after(async (request) => {
      if (request.transferOffset !== 0) return;
      called = true;
      expect(
        name === "fd_write"
          ? sync.write(other)
          : sync.run("fd_pwrite", ["i32", "i32", "i32", "i64", "i32"], [other, 0, 1, 0, 16]),
      ).toBe(0);
    });
    try {
      expect(await a.run(fd)).toBe(0);
      expect(called).toBe(true);
      expect(sync.write(other)).toBe(0);
      expect(await b.run(other)).toBe(0);
      expect(
        readFile(fixture.filesystem, "/log", SIZE + (name === "fd_write" ? 15 : 9)).subarray(-9),
      ).toEqual(new TextEncoder().encode("INLINEBBB"));
    } finally {
      a.close();
      b.close();
      await sync.close();
      fixture.close();
    }
  });

  it("releases the offset lock when an abandoned inode acquisition returns", async () => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open("/log", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
    const descriptor = fixture.filesystem.descriptors.get(fd);
    const acquired = kernelFileWriteLock(descriptor.mount!.storage, descriptor.inode!)
      .acquire({})
      .next();
    if (!acquired.done) throw new Error("Uncontended lock suspended");
    const release = acquired.value;
    const pending = descriptor.acquireIo({}, true);
    try {
      expect(pending.next().done).toBe(false);
      pending.return(() => {});
      const next = descriptor.acquireIo({}, false);
      const result = next.next();
      if (result.done) result.value();
      else next.return(() => {});
      expect(result.done).toBe(true);
    } finally {
      release();
      fixture.close();
    }
  });

  it.each(["truncate", "ftruncate", "open", "wasi_size", "wasi_open"] as const)(
    "keeps sync %s between append chunks from creating a NUL hole",
    async (kind) => {
      const fixture = createTestFilesystem();
      const fd = fixture.filesystem.open(
        "/log",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR | KernelOpenFlags.O_APPEND,
      );
      fixture.filesystem.write(fd, new Uint8Array(1000).fill(0x2e), 0n);
      const a = guest(fixture.filesystem, "fd_write");
      a.bytes.fill(0x41);
      let prefix = 0;
      a.after(async (request, response) => {
        if (request.transferOffset !== 0) return;
        expect(response.kind).toBe("return");
        prefix = Number(fixture.filesystem.fstat(fd).size) - 1000;
        if (kind === "truncate") fixture.filesystem.truncate("/log", 0n);
        else if (kind === "ftruncate") fixture.filesystem.ftruncate(fd, 0n);
        else if (kind === "open")
          fixture.filesystem.close(
            fixture.filesystem.open("/log", KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC),
          );
        else {
          const sync = inline(fixture.filesystem);
          try {
            if (kind === "wasi_size")
              expect(sync.run("fd_filestat_set_size", ["i32", "i64"], [fd, 0])).toBe(0);
            else {
              sync.data.set(new TextEncoder().encode("log"), 64);
              const directory = fixture.filesystem.open(
                "/",
                KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
              );
              expect(
                sync.run(
                  "path_open",
                  ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
                  [directory, 0, 64, 3, 8, 0, 0, 0, 16],
                ),
              ).toBe(0);
            }
          } finally {
            await sync.close();
          }
        }
      });
      try {
        expect(await a.run(fd)).toBe(0);
        expect(prefix).toBeGreaterThan(0);
        expect(fixture.filesystem.fstat(fd).size).toBe(BigInt(SIZE - prefix));
        expect(
          readFile(fixture.filesystem, "/log", SIZE - prefix).every((byte) => byte === 0x41),
        ).toBe(true);
      } finally {
        a.close();
        fixture.close();
      }
    },
  );

  it("does not shrink a completed write when an allocation waited for its inode lock", async () => {
    const fixture = createTestFilesystem();
    const fd = fixture.filesystem.open(
      "/log",
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR | KernelOpenFlags.O_APPEND,
    );
    const other = fixture.filesystem.open("/log", KernelOpenFlags.O_RDWR);
    const a = guest(fixture.filesystem, "fd_write");
    const host = createKernelSyscallHost({
      filesystem: fixture.filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    a.bytes.fill(0x41);
    let allocating: Promise<KernelSyscallResponse> | undefined;
    a.after(async (request) => {
      if (request.transferOffset === 0)
        allocating = host.call({
          name: "fd_allocate",
          args: [other, 0n, 65536n],
          memorySize: 0,
          regions: [],
        });
    });
    try {
      expect(await a.run(fd)).toBe(0);
      expect(await allocating).toMatchObject({ kind: "return", value: 0 });
      expect(fixture.filesystem.fstat(fd).size).toBe(BigInt(SIZE));
    } finally {
      a.close();
      host.close();
      fixture.close();
    }
  });

  it.each(["fd_filestat_set_size", "path_open"])(
    "serializes async %s after the complete append",
    async (name) => {
      const fixture = createTestFilesystem();
      const fd = fixture.filesystem.open(
        "/log",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR | KernelOpenFlags.O_APPEND,
      );
      fixture.filesystem.write(fd, new Uint8Array(1000).fill(0x2e), 0n);
      const other = fixture.filesystem.open("/log", KernelOpenFlags.O_WRONLY);
      const directory = fixture.filesystem.open(
        "/",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      const host = createKernelSyscallHost({
        filesystem: fixture.filesystem,
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      const a = guest(fixture.filesystem, "fd_write");
      a.bytes.fill(0x41);
      let truncating: Promise<KernelSyscallResponse> | undefined;
      a.after(async (request) => {
        if (request.transferOffset !== 0) return;
        truncating = host.call(
          name === "fd_filestat_set_size"
            ? { name, args: [other, 0n], memorySize: 0, regions: [] }
            : {
                name,
                args: [directory, 0, 64, 3, 8, 0n, 0n, 0, 16],
                memorySize: 128,
                regions: [
                  { pointer: 16, direction: "out", length: 4, bytes: new Uint8Array() },
                  { pointer: 64, direction: "in", bytes: new TextEncoder().encode("log") },
                ],
              },
        );
      });
      try {
        expect(await a.run(fd)).toBe(0);
        expect(await truncating).toMatchObject({ kind: "return", value: 0 });
        expect(fixture.filesystem.fstat(fd).size).toBe(0n);
      } finally {
        a.close();
        host.close();
        fixture.close();
      }
    },
  );
});
