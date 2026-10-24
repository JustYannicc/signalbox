import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import type { KernelSyscallPort } from "../../kernel/KernelSyscallPort.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const OUTPUT_POINTER = 1024;
const COUNT_POINTER = 32;
const SENTINEL = 0xa5;

describe("child WASI path transfers", () => {
  it("returns the complete UTF-8 directory listing without touching the unused buffer", async () => {
    const fixture = createTestFilesystem();
    let guest: ChildGuest | undefined;

    try {
      const createdNames = Array.from(
        { length: 200 },
        (_, index) =>
          `entry-${index.toString().padStart(3, "0")}-${"界".repeat(8)}-${"🎉".repeat(3)}`,
      );
      for (const name of createdNames) {
        const fd = fixture.filesystem.open(
          `/${name}`,
          KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
        );
        fixture.filesystem.close(fd);
      }
      const fileNames = [...createdNames].sort();
      expect(fixture.filesystem.readdir("/")).toEqual(fileNames);
      const expectedNames = [".", "..", ...fileNames];
      const expectedByteCount = expectedNames.reduce(
        (total, name) => total + 24 + new TextEncoder().encode(name).byteLength,
        0,
      );

      guest = createChildGuest(fixture.filesystem, "fd_readdir", [
        "i32",
        "i32",
        "i32",
        "i64",
        "i32",
      ]);
      const directoryFd = rootPreopenFd(fixture.filesystem);
      const bufferCapacity = 16 * 1024;
      const bytes = new Uint8Array(guest.memory.buffer, OUTPUT_POINTER, bufferCapacity);
      bytes.fill(SENTINEL);

      expect(await guest.run(directoryFd, OUTPUT_POINTER, bufferCapacity, 0n, COUNT_POINTER)).toBe(
        0,
      );

      const used = new DataView(guest.memory.buffer).getUint32(COUNT_POINTER, true);
      expect(used).toBe(expectedByteCount);
      expect(parseDirectory(bytes.subarray(0, used))).toEqual(
        expectedNames.map((name, index) => ({ name, nextCookie: BigInt(index + 1) })),
      );
      expect(bytes.subarray(used).every((byte) => byte === SENTINEL)).toBe(true);
    } finally {
      guest?.close();
      fixture.close();
    }
  });

  it("returns an aliased readlink target exactly and leaves the rest untouched", async () => {
    const fixture = createTestFilesystem();
    let guest: ChildGuest | undefined;

    try {
      const target = `../target-${"é".repeat(20)}-${"界".repeat(8)}-🎉`;
      const expected = new TextEncoder().encode(target);
      fixture.filesystem.symlink(target, "/long-link");
      const path = new TextEncoder().encode("long-link");
      const pathPointer = 64;
      guest = createChildGuest(fixture.filesystem, "path_readlink", [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
      ]);
      const directoryFd = rootPreopenFd(fixture.filesystem);
      const bufferCapacity = 2 * 1024 * 1024;
      guest.memory.grow(Math.ceil(bufferCapacity / 65_536));
      const output = new Uint8Array(guest.memory.buffer, pathPointer, bufferCapacity);
      output.fill(SENTINEL);
      new Uint8Array(guest.memory.buffer, pathPointer, path.byteLength).set(path);

      expect(
        await guest.run(
          directoryFd,
          pathPointer,
          path.byteLength,
          pathPointer,
          bufferCapacity,
          COUNT_POINTER,
        ),
      ).toBe(0);

      expect(output.subarray(0, expected.byteLength)).toEqual(expected);
      expect(output.subarray(expected.byteLength).every((byte) => byte === SENTINEL)).toBe(true);
      expect(new DataView(guest.memory.buffer).getUint32(COUNT_POINTER, true)).toBe(
        expected.byteLength,
      );
    } finally {
      guest?.close();
      fixture.close();
    }
  });
});

type WasiArgument = number | bigint;
type GuestCall = (...args: WasiArgument[]) => Promise<unknown>;
type GuestFilesystem = ReturnType<typeof createTestFilesystem>["filesystem"];

interface ChildGuest {
  readonly memory: WebAssembly.Memory;
  readonly run: GuestCall;
  close(): void;
}

function createChildGuest(
  filesystem: GuestFilesystem,
  name: string,
  params: readonly ("i32" | "i64")[],
): ChildGuest {
  const module = wasmImportReactor("wasi_snapshot_preview1", name, params, ["i32"]);
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const port: KernelSyscallPort = {
    async call(request) {
      return structuredClone(await host.call(structuredClone(request)));
    },
  };
  const child = createChildWasi({ module, syscalls: port, args: [], env: {} });
  const instance = new WebAssembly.Instance(module, child.imports);
  const run = instance.exports.run;
  if (typeof run !== "function") throw new TypeError("WASI test reactor has no run export");
  child.bind(instance);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory))
    throw new TypeError("WASI test reactor has no memory");
  return {
    memory,
    run: (...args) => child.run(run, ...args),
    close: () => host.close(),
  };
}

function rootPreopenFd(filesystem: GuestFilesystem): number {
  const entry = [...filesystem.descriptors.entries()].find(
    ([, descriptor]) => descriptor.kind === "directory" && descriptor.preopen,
  );
  if (entry === undefined) throw new Error("Test filesystem has no root preopen");
  return entry[0];
}

function parseDirectory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: Array<{ name: string; nextCookie: bigint }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 24 > bytes.byteLength) throw new Error("Truncated WASI dirent header");
    const nextCookie = view.getBigUint64(offset, true);
    const nameLength = view.getUint32(offset + 16, true);
    const nameStart = offset + 24;
    const end = nameStart + nameLength;
    if (end > bytes.byteLength) throw new Error("Truncated WASI dirent name");
    entries.push({ name: decoder.decode(bytes.subarray(nameStart, end)), nextCookie });
    offset = end;
  }
  return entries;
}
