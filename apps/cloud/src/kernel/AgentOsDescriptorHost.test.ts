import { describe, expect, it } from "vite-plus/test";
import { AgentOsDescriptorHost } from "./AgentOsDescriptorHost.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { FDFLAGS, RIGHTS, WasiDescriptorTable } from "./wasi/internal_wasi_descriptors.ts";
import type { WasiStdio } from "./wasi/internal_wasi_fs.ts";

type PollableStdio = WasiStdio & {
  poll: (
    direction: "read" | "write",
    signal?: AbortSignal,
  ) =>
    | { readonly bytes: bigint; readonly hangup?: boolean }
    | Promise<{
        readonly bytes: bigint;
        readonly hangup?: boolean;
      }>;
};

function fixture(
  asyncMode = false,
  currentSignal: () => AbortSignal | undefined = () => undefined,
) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const stdio: WasiStdio[] = [{ readInto: () => 0 }, { write: () => 0 }, { write: () => 0 }];
  const descriptors = new WasiDescriptorTable(stdio);
  const wakes = new KernelWakeRegistry();
  const host = new AgentOsDescriptorHost({
    memory: () => memory,
    descriptors,
    wakes,
    asyncMode,
    currentSignal,
  });
  const result = (pointer: number) => new DataView(memory.buffer).getUint32(pointer, true);
  const pair = () => {
    expect(host.imports.fd_pipe(0, 4)).toBe(0);
    return [result(0), result(4)] as const;
  };
  return { memory, descriptors, wakes, host, result, pair };
}

describe("AgentOS host_process descriptor imports", () => {
  it("allocates a real pipe on the shared table and validates both output pointers first", async () => {
    const test = fixture(true);
    try {
      expect(test.host.imports.fd_pipe(0, 65_534)).toBe(21);
      expect([...test.descriptors.entries()].map(([fd]) => fd)).toEqual([0, 1, 2]);

      const [readFd, writeFd] = test.pair();
      expect([readFd, writeFd]).toEqual([3, 4]);
      const reader = test.descriptors.get(readFd);
      const writer = test.descriptors.get(writeFd);
      expect(reader.kind).toBe("stdio");
      expect(writer.kind).toBe("stdio");
      expect(reader.offset).toBe(0n);
      expect(writer.offset).toBe(0n);
      expect(reader.rightsBase).toBe(
        RIGHTS.FD_READ | RIGHTS.POLL_FD_READWRITE | RIGHTS.FD_FDSTAT_SET_FLAGS,
      );
      expect(writer.rightsBase).toBe(
        RIGHTS.FD_WRITE | RIGHTS.POLL_FD_READWRITE | RIGHTS.FD_FDSTAT_SET_FLAGS,
      );

      const payload = new Uint8Array([7, 8, 9]);
      expect(await writer.stdio?.write?.(payload)).toBe(3);
      const received = new Uint8Array(3);
      expect(await reader.stdio?.readInto?.(received)).toBe(3);
      expect(received).toEqual(payload);
    } finally {
      test.wakes.dispose();
    }
  });

  it("shares pipe flags through aliases and honors nonblocking I/O", async () => {
    const test = fixture(true);
    try {
      const [readFd, writeFd] = test.pair();
      const readAliasPointer = 8;
      expect(test.host.imports.fd_dup(readFd, readAliasPointer)).toBe(0);
      const readAlias = test.result(readAliasPointer);
      test.descriptors.get(readAlias).flags = FDFLAGS.NONBLOCK;
      expect(test.descriptors.get(readFd).flags).toBe(FDFLAGS.NONBLOCK);
      await expect(
        test.descriptors.get(readFd).stdio?.readInto?.(new Uint8Array(1)),
      ).rejects.toMatchObject({ code: "EAGAIN" });

      const writer = test.descriptors.get(writeFd);
      writer.flags = FDFLAGS.NONBLOCK;
      expect(await writer.stdio?.write?.(new Uint8Array(65_536))).toBe(65_536);
      await expect(writer.stdio?.write?.(new Uint8Array(1))).rejects.toMatchObject({
        code: "EAGAIN",
      });
    } finally {
      test.wakes.dispose();
    }
  });

  it("wakes a pending pipe poll through the shared wake registry", async () => {
    const test = fixture(true);
    try {
      const [readFd, writeFd] = test.pair();
      const reader = test.descriptors.get(readFd).stdio as PollableStdio;
      const writer = test.descriptors.get(writeFd).stdio as PollableStdio;
      const waiting = reader.poll("read");
      expect(waiting).toBeInstanceOf(Promise);
      expect(test.wakes.size).toBe(1);

      expect(await writer.write?.(new Uint8Array([2, 4, 6]))).toBe(3);
      expect(await waiting).toEqual({ bytes: 3n });
      expect(test.wakes.size).toBe(0);
    } finally {
      test.wakes.dispose();
    }
  });

  it("reads the current inherited signal for each pipe I/O", async () => {
    let current: AbortSignal | undefined;
    const test = fixture(true, () => current);
    const abort = new AbortController();
    try {
      const [readFd] = test.pair();
      current = abort.signal;
      const read = test.descriptors.get(readFd).stdio?.readInto?.(new Uint8Array(1));
      abort.abort();
      await expect(read).rejects.toMatchObject({ code: "ECANCELED" });
      expect(test.wakes.size).toBe(0);
    } finally {
      test.wakes.dispose();
    }
  });

  it("duplicates through the table with POSIX close-on-exec rules", () => {
    const test = fixture();
    try {
      const [readFd, writeFd] = test.pair();
      const resultPointer = 8;
      expect(test.host.imports.fd_setfd(writeFd, 1)).toBe(0);
      expect(test.host.imports.fd_dup2(writeFd, 10)).toBe(0);
      expect(test.host.imports.fd_getfd(10, resultPointer)).toBe(0);
      expect(test.result(resultPointer)).toBe(0);

      expect(test.host.imports.fd_setfd(writeFd, 1)).toBe(0);
      expect(test.host.imports.fd_dup2(writeFd, writeFd)).toBe(0);
      expect(test.host.imports.fd_getfd(writeFd, resultPointer)).toBe(0);
      expect(test.result(resultPointer)).toBe(1);

      expect(test.host.imports.fd_dup_min(readFd, 5, resultPointer)).toBe(0);
      const minimumDuplicate = test.result(resultPointer);
      expect(minimumDuplicate).toBe(5);
      expect(test.host.imports.fd_getfd(minimumDuplicate, resultPointer)).toBe(0);
      expect(test.result(resultPointer)).toBe(0);
      expect(test.host.imports.fd_dup_min(readFd, 0x8000_0000, resultPointer)).toBe(28);

      expect(test.host.imports.fd_getfd(readFd, 65_534)).toBe(21);
      expect(test.host.imports.fd_dup(readFd, 65_534)).toBe(21);
      expect(test.host.imports.fd_setfd(0xffff_ffff, 0)).toBe(8);
    } finally {
      test.wakes.dispose();
    }
  });

  it("closes every descriptor at or above the cutoff and closes pipe writers on last alias", () => {
    const test = fixture();
    try {
      const [readFd, writeFd] = test.pair();
      const aliasPointer = 8;
      expect(test.host.imports.fd_dup(writeFd, aliasPointer)).toBe(0);
      expect(test.result(aliasPointer)).toBe(5);

      expect(test.host.imports.proc_closefrom(writeFd)).toBe(0);
      expect(test.descriptors.has(readFd)).toBe(true);
      expect(test.descriptors.has(writeFd)).toBe(false);
      expect(test.descriptors.has(test.result(aliasPointer))).toBe(false);
      const reader = test.descriptors.get(readFd);
      const bytes = new Uint8Array(1);
      expect(reader.stdio?.readInto?.(bytes)).toBe(0);
    } finally {
      test.wakes.dispose();
    }
  });

  it("returns ENOTSUP for valid record-lock requests and preserves output memory", () => {
    const test = fixture();
    try {
      const [readFd] = test.pair();
      new Uint8Array(test.memory.buffer, 16, 24).fill(0x7f);
      const pointers = [16, 20, 24, 32];
      expect(
        test.host.imports.fd_record_lock(
          readFd,
          12,
          0,
          0n,
          8n,
          pointers[0]!,
          pointers[1]!,
          pointers[2]!,
          pointers[3]!,
        ),
      ).toBe(58);
      expect([...new Uint8Array(test.memory.buffer, 16, 24)]).toEqual(new Array(24).fill(0x7f));
      expect(test.host.imports.fd_record_lock(99, 13, 2, 0n, 0n, 16, 20, 24, 32)).toBe(8);
      expect(test.host.imports.fd_record_lock(readFd, 12, 2, 0n, 0n, 16, 20, 24, 32)).toBe(28);
    } finally {
      test.wakes.dispose();
    }
  });

  it("marks only async close operations as suspending", async () => {
    const synchronous = fixture();
    const asynchronous = fixture(true);
    try {
      expect(synchronous.host.suspendingImports).toEqual([]);
      expect(synchronous.host.getImportObject().host_process.fd_pipe).toBe(
        synchronous.host.imports.fd_pipe,
      );
      expect(asynchronous.host.suspendingImports).toEqual(["fd_dup2", "proc_closefrom"]);
      const failedDup = asynchronous.host.imports.fd_dup2(99, 1);
      expect(failedDup).toBeInstanceOf(Promise);
      expect(await failedDup).toBe(8);
      const [readFd] = asynchronous.pair();
      const closed = asynchronous.host.imports.proc_closefrom(readFd);
      expect(closed).toBeInstanceOf(Promise);
      expect(await closed).toBe(0);
    } finally {
      synchronous.wakes.dispose();
      asynchronous.wakes.dispose();
    }
  });
});
