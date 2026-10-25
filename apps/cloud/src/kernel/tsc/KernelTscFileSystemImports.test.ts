import { describe, expect, it } from "vite-plus/test";
import type {
  KernelTscFileSystemPort,
  KernelTscFileSystemRequest,
  KernelTscFileSystemResponse,
} from "../KernelTscFileSystem.ts";
import { createKernelTscHostImports } from "../KernelTscHostImports.ts";
import { tscGuest } from "./tests/TscWasmFixture.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface JSPI {
  promising(fn: (...args: number[]) => number): (...args: number[]) => Promise<number>;
}

describe("tsc-rs filesystem imports", () => {
  it("bridges bytes, metadata, directories and realpaths after an async memory grow", async () => {
    const calls: KernelTscFileSystemRequest[] = [];
    const filesystem = port((request) => {
      calls.push(request);
      switch (request.op) {
        case "read":
          return { kind: "bytes", bytes: new Uint8Array([0, 255, 10]) };
        case "stat":
          return { kind: "stat", type: "file", size: 17n, mtimeNs: 1_800_000_000_000_000_001n };
        case "readDirectory":
          return {
            kind: "entries",
            entries: [
              { name: "a.ts", kind: "file" },
              { name: "link", kind: "symlink" },
            ],
          };
        case "realpath":
          return { kind: "path", path: "/workspace/src/main.ts" };
        default:
          return { kind: "written" };
      }
    });
    let guestMemory: WebAssembly.Memory | undefined;
    const asyncFilesystem = port(async (request) => {
      guestMemory?.grow(1);
      return filesystem.execute(request);
    });

    const read = await callHost(asyncFilesystem, 0, "/workspace/a.ts");
    expect(read.status).toBe(3);
    expect([...read.bytes]).toEqual([0, 255, 10]);
    guestMemory = read.memory;
    const stat = await callHost(asyncFilesystem, 1, "/workspace/a.ts");
    expect(decoder.decode(stat.bytes)).toBe("f 17 1800000000000000001");
    const directory = await callHost(asyncFilesystem, 2, "/workspace");
    expect(decoder.decode(directory.bytes)).toBe("fa.ts\0llink\0");
    const realpath = await callHost(asyncFilesystem, 3, "/workspace/src/main.ts");
    expect(decoder.decode(realpath.bytes)).toBe("/workspace/src/main.ts");
    expect(calls.map(({ op }) => op)).toEqual(["read", "stat", "readDirectory", "realpath"]);
  });

  it("preserves binary writes, append, remove, nanosecond times and write error text", async () => {
    const calls: KernelTscFileSystemRequest[] = [];
    const filesystem = port((request) => {
      calls.push(request);
      return request.op === "write" && request.append
        ? { kind: "error", message: "open /workspace/out: permission denied" }
        : { kind: "written" };
    });
    const write = await callHost(
      filesystem,
      4,
      new Uint8Array([...encoder.encode("/workspace/out"), 0, 0, 255]),
    );
    expect(write.status).toBe(0);
    expect(calls[0]).toMatchObject({ op: "write", path: "/workspace/out", append: false });
    expect(calls[0]?.op === "write" ? [...calls[0].data] : []).toEqual([0, 255]);

    const append = await callHost(filesystem, 5, "/workspace/out\0tail");
    expect(append.status).toBeLessThan(-1);
    expect(decoder.decode(append.bytes)).toBe("open /workspace/out: permission denied");
    expect(calls[1]).toMatchObject({ op: "write", path: "/workspace/out", append: true });

    const remove = await callHost(filesystem, 6, "/workspace/out");
    expect(remove.status).toBe(0);
    const times = await callHost(
      filesystem,
      7,
      new Uint8Array([
        ...encoder.encode("/workspace/out"),
        0,
        0,
        ...encoder.encode("1800000000000000001"),
      ]),
    );
    expect(times.status).toBe(0);
    expect(calls[2]).toEqual({ op: "remove", path: "/workspace/out" });
    expect(calls[3]).toMatchObject({
      op: "chtimes",
      path: "/workspace/out",
      mtimeNs: 1_800_000_000_000_000_001n,
    });
  });
});

function port(
  execute: (
    request: KernelTscFileSystemRequest,
  ) => KernelTscFileSystemResponse | Promise<KernelTscFileSystemResponse>,
): KernelTscFileSystemPort {
  return { execute: async (request) => execute(request) };
}

async function callHost(
  filesystem: KernelTscFileSystemPort,
  op: number,
  value: string | Uint8Array,
) {
  let memory: WebAssembly.Memory | undefined;
  const instance = new WebAssembly.Instance(
    tscGuest(),
    createKernelTscHostImports(filesystem, () => {
      if (memory === undefined) throw new Error("guest memory is not bound");
      return memory;
    }),
  );
  memory = instance.exports.memory as WebAssembly.Memory;
  const input = typeof value === "string" ? encoder.encode(value) : value;
  const inputPointer = 32;
  const outputPointer = 512;
  new Uint8Array(memory.buffer).set(input, inputPointer);
  const wasm = WebAssembly as unknown as JSPI;
  const run = wasm.promising(instance.exports.call as (...args: number[]) => number);
  const status = await run(op, inputPointer, input.byteLength, outputPointer);
  const outputLength = status >= 0 ? status : status < -1 ? -2 - status : 0;
  return {
    status,
    bytes: new Uint8Array(memory.buffer, outputPointer, outputLength).slice(),
    memory,
  };
}
