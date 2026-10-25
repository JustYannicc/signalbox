import { expect, it, vi } from "vite-plus/test";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";

const MIB = 1024 * 1024;
const PIPE_READ_BYTES = 64 * 1024;

function readRequest(output = true): KernelSyscallRequest {
  const vectors = new Uint8Array(8);
  const table = new DataView(vectors.buffer);
  table.setUint32(0, 128, true);
  table.setUint32(4, MIB, true);
  return {
    name: "fd_read",
    args: [0, 0, 1, 16],
    memorySize: 128 + MIB,
    regions: [
      { pointer: 0, direction: "in", bytes: vectors },
      { pointer: 16, direction: "out", length: 4, bytes: new Uint8Array() },
      ...(output
        ? [{ pointer: 128, direction: "out" as const, length: MIB, bytes: new Uint8Array() }]
        : []),
    ],
    transferOffset: 0,
    transferLength: MIB,
  };
}

it("allocates a stdio read output to the bytes produced, not its reserved transfer size", async () => {
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {
        readInto(target) {
          target.fill(0x5a);
          return PIPE_READ_BYTES;
        },
      },
      {},
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const allocations: Array<{ readonly length: number; readonly buffer: ArrayBufferLike }> = [];
  const NativeUint8Array = globalThis.Uint8Array;
  const TrackedUint8Array = new Proxy(NativeUint8Array, {
    construct(target, args, newTarget) {
      const bytes = Reflect.construct(target, args, newTarget) as Uint8Array;
      if (typeof args[0] === "number") allocations.push({ length: args[0], buffer: bytes.buffer });
      return bytes;
    },
  });

  let response: Awaited<ReturnType<typeof host.call>> | undefined;
  try {
    vi.stubGlobal("Uint8Array", TrackedUint8Array);
    response = await host.call(readRequest());
  } finally {
    vi.unstubAllGlobals();
    host.close();
    filesystem.dispose();
  }

  expect(response?.kind).toBe("return");
  if (response === undefined || response.kind !== "return") return;
  const count = response.regions.find((region) => region.pointer === 16);
  const output = response.regions.find((region) => region.pointer === 128);
  expect(count?.bytes.byteLength).toBe(4);
  if (count === undefined) return;
  expect(new DataView(count.bytes.buffer, count.bytes.byteOffset, 4).getUint32(0, true)).toBe(
    PIPE_READ_BYTES,
  );
  expect(output?.bytes.byteLength).toBe(PIPE_READ_BYTES);
  expect(output?.bytes.every((byte) => byte === 0x5a)).toBe(true);
  expect(allocations.filter((allocation) => allocation.length === MIB)).toHaveLength(0);
  expect(
    allocations.some(
      (allocation) =>
        allocation.length === PIPE_READ_BYTES && allocation.buffer === output?.bytes.buffer,
    ),
  ).toBe(true);
});

it("rejects a missing stdio output region before consuming input", async () => {
  let reads = 0;
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {
        readInto(target) {
          reads++;
          target.fill(0x5a);
          return target.byteLength;
        },
      },
      {},
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });

  try {
    let rejected = false;
    try {
      const response = await host.call(readRequest(false));
      rejected = response.kind !== "return" || response.value !== 0;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(reads).toBe(0);
  } finally {
    host.close();
    filesystem.dispose();
  }
});

it.each([1, 16])(
  "drains %i available pipe chunks without growing or copying prior output",
  async (chunks) => {
    let reads = 0;
    const filesystem = new KernelFileSystem({
      mounts: [],
      stdio: [
        {
          supportsNonblocking: true,
          readInto(target) {
            if (reads === chunks) throw Object.assign(new Error("empty"), { code: "EAGAIN" });
            reads++;
            target.fill(reads);
            return target.byteLength;
          },
        },
        {},
        {},
      ],
    });
    const host = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const allocations: number[] = [];
    const Native = globalThis.Uint8Array;
    const Tracked = new Proxy(Native, {
      construct(target, args, newTarget) {
        if (typeof args[0] === "number") allocations.push(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      const request = readRequest();
      vi.stubGlobal("Uint8Array", Tracked);
      const result = await host.call(request);
      vi.unstubAllGlobals();
      expect(result.kind).toBe("return");
      if (result.kind !== "return") return;
      expect(result.value).toBe(0);
      const output = result.regions.filter((region) => region.pointer >= 128);
      expect(output.reduce((sum, region) => sum + region.bytes.byteLength, 0)).toBe(
        chunks * PIPE_READ_BYTES,
      );
      expect(reads).toBe(chunks);
      expect(
        output.every((region, index) => region.bytes.every((byte) => byte === index + 1)),
      ).toBe(true);
      expect(allocations.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(
        (chunks + 1) * PIPE_READ_BYTES + 128,
      );
    } finally {
      vi.unstubAllGlobals();
      host.close();
      filesystem.dispose();
    }
  },
);
