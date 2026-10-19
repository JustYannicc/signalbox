import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem, type WasiStdio } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import type { KernelSyscallPort, KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { ChildWasiExit, createChildWasi } from "../ChildWasi.ts";
import { MemoryRegions } from "../wasi/MemoryRegions.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("ChildWasi", () => {
  it("sends only fd_read ABI ranges and copies exact binary output back into guest memory", async () => {
    const input = Uint8Array.from([0x00, 0x80, 0xff, 0x42]);
    let inputOffset = 0;
    const fixture = harness({
      stdio: [
        {
          readInto(target) {
            const length = Math.min(target.byteLength, input.byteLength - inputOffset);
            target.set(input.subarray(inputOffset, inputOffset + length));
            inputOffset += length;
            return length;
          },
        },
        {},
        {},
      ],
    });
    const module = wasmImportRun(
      "wasi_snapshot_preview1",
      "fd_read",
      ["i32", "i32", "i32", "i32"],
      ["i32"],
    );
    const child = createChildWasi({
      module,
      syscalls: fixture.syscalls,
      args: [],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);
    const memory = guestMemory(instance);
    const view = new DataView(memory.buffer);
    view.setUint32(32, 128, true);
    view.setUint32(36, input.byteLength, true);
    new Uint8Array(memory.buffer)[512] = 0x7e;

    try {
      expect(await child.run(guestRun(instance), 0, 32, 1, 16)).toBe(0);
      expect(view.getUint32(16, true)).toBe(input.byteLength);
      expect(new Uint8Array(memory.buffer, 128, input.byteLength)).toEqual(input);
      expect(new Uint8Array(memory.buffer)[512]).toBe(0x7e);
      expect(regionBounds(fixture.requests[0]!)).toEqual([
        [16, 4],
        [32, 8],
        [128, input.byteLength],
      ]);
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("uses validated argv and environment string order and byte lengths", async () => {
    const args = ["/bin/child", "Grüße 🌍"];
    const env = { ZED: "second", ALPHA: "雪" };
    const fixture = harness({ args, env });

    try {
      const argsSizes = await runGuest(
        fixture.syscalls,
        args,
        env,
        "args_sizes_get",
        ["i32", "i32"],
        ["i32"],
        [0, 4],
      );
      const argsMemory = guestMemory(argsSizes.instance);
      const argsSize = args.reduce((size, value) => size + bytes(value).byteLength + 1, 0);
      expect(new DataView(argsMemory.buffer).getUint32(0, true)).toBe(args.length);
      expect(new DataView(argsMemory.buffer).getUint32(4, true)).toBe(argsSize);
      expect(regionBounds(fixture.requests[0]!)).toEqual([[0, 8]]);

      const argsGet = await runGuest(
        fixture.syscalls,
        args,
        env,
        "args_get",
        ["i32", "i32"],
        ["i32"],
        [8, 64],
      );
      const argsGetMemory = guestMemory(argsGet.instance);
      expect(stringVector(argsGetMemory, 8, 64, args.length)).toEqual(args);
      expect(regionBounds(fixture.requests[1]!)).toEqual([
        [8, args.length * 4],
        [64, argsSize],
      ]);

      const entries = Object.entries(env).map(([key, value]) => `${key}=${value}`);
      const envSize = entries.reduce((size, value) => size + bytes(value).byteLength + 1, 0);
      const envSizes = await runGuest(
        fixture.syscalls,
        args,
        env,
        "environ_sizes_get",
        ["i32", "i32"],
        ["i32"],
        [16, 20],
      );
      const envSizesMemory = guestMemory(envSizes.instance);
      expect(new DataView(envSizesMemory.buffer).getUint32(16, true)).toBe(entries.length);
      expect(new DataView(envSizesMemory.buffer).getUint32(20, true)).toBe(envSize);
      expect(regionBounds(fixture.requests[2]!)).toEqual([[16, 8]]);

      const envGet = await runGuest(
        fixture.syscalls,
        args,
        env,
        "environ_get",
        ["i32", "i32"],
        ["i32"],
        [24, 96],
      );
      const envGetMemory = guestMemory(envGet.instance);
      expect(stringVector(envGetMemory, 24, 96, entries.length)).toEqual(entries);
      expect(regionBounds(fixture.requests[3]!)).toEqual([
        [24, entries.length * 4],
        [96, envSize],
      ]);
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("returns host errno before inspecting an invalid iovec when descriptor rights reject the call", async () => {
    const fixture = harness({ stdio: [{}, {}, {}] });
    const module = wasmImportRun(
      "wasi_snapshot_preview1",
      "fd_read",
      ["i32", "i32", "i32", "i32"],
      ["i32"],
    );
    const child = createChildWasi({
      module,
      syscalls: fixture.syscalls,
      args: [],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);

    try {
      expect(await child.run(guestRun(instance), 1, -8, 1, 16)).toBe(76);
      expect(regionBounds(fixture.requests[0]!)).toEqual([[16, 4]]);
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("omits iovec-derived ranges above the ABI limit so the host can reject the count", async () => {
    const fixture = harness({ stdio: [{ readInto: () => 0 }, {}, {}] });
    const module = wasmImportRun(
      "wasi_snapshot_preview1",
      "fd_read",
      ["i32", "i32", "i32", "i32"],
      ["i32"],
    );
    const child = createChildWasi({
      module,
      syscalls: fixture.syscalls,
      args: [],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);

    try {
      expect(await child.run(guestRun(instance), 0, 32, 1025, 16)).toBe(28);
      expect(regionBounds(fixture.requests[0]!)).toEqual([[16, 4]]);
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("returns proc_exit through start without sending any guest memory", async () => {
    const fixture = harness({ stdio: [{}, {}, {}] });
    const module = wasmProcExit(23);
    const child = createChildWasi({
      module,
      syscalls: fixture.syscalls,
      args: [],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, child.imports);

    try {
      expect(await child.start(instance)).toBe(23);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({ name: "proc_exit", args: [23], regions: [] });
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("returns reactor proc_exit(70) as its numeric run result", async () => {
    const fixture = harness({ stdio: [{}, {}, {}] });
    const module = wasmImportRun("wasi_snapshot_preview1", "proc_exit", ["i32"], []);
    const child = createChildWasi({
      module,
      syscalls: fixture.syscalls,
      args: [],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);

    try {
      expect(await child.run(guestRun(instance), 70)).toBe(70);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({ name: "proc_exit", args: [70], regions: [] });
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("preserves ordinary numeric reactor results", async () => {
    const fixture = harness({ stdio: [{}, {}, {}] });

    try {
      for (const value of [0, 2]) {
        const module = wasmRunConstant(value);
        const child = createChildWasi({
          module,
          syscalls: fixture.syscalls,
          args: [],
          env: {},
        });
        const instance = new WebAssembly.Instance(module, child.imports);
        child.bind(instance);
        expect(await child.run(guestRun(instance))).toBe(value);
      }
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("keeps initialize exit status public through ChildWasiExit", async () => {
    const fixture = harness({ stdio: [{}, {}, {}] });
    const module = wasmProcExit(70, "_initialize");
    const child = createChildWasi({
      module,
      syscalls: fixture.syscalls,
      args: [],
      env: {},
    });
    const instance = new WebAssembly.Instance(module, child.imports);

    try {
      const error = await child.initialize(instance).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ChildWasiExit);
      expect(error).toMatchObject({ code: 70 });
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("merges overlapping ranges, omits invalid pointers, and bounds response writes", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const regions = new MemoryRegions(memory);
    regions.add(20, 8);
    regions.add(8, 16);
    regions.add(-8, 16);
    expect(regionBounds({ regions: regions.snapshot() })).toEqual([[8, 20]]);
    expect(() => regions.apply([{ pointer: 512, bytes: Uint8Array.of(1) }])).toThrow(
      "Invalid syscall memory response regions",
    );

    const oversizedVectors = new MemoryRegions(memory);
    oversizedVectors.addIovecs(0, 1025);
    expect(oversizedVectors.snapshot()).toEqual([]);
  });
});

interface HarnessOptions {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdio?: readonly [WasiStdio, WasiStdio, WasiStdio];
}

function harness(options: HarnessOptions = {}) {
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: options.stdio ?? [{}, {}, {}],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: options.args ?? [],
    env: options.env ?? {},
    signal: new AbortController().signal,
  });
  const requests: KernelSyscallRequest[] = [];
  const syscalls: KernelSyscallPort = {
    async call(request) {
      requests.push({
        ...request,
        regions: request.regions.map(({ pointer, bytes }) => ({ pointer, bytes: bytes.slice() })),
      });
      return host.call(request);
    },
  };
  return { filesystem, requests, syscalls };
}

async function runGuest(
  syscalls: KernelSyscallPort,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  importName: string,
  params: readonly ValueType[],
  results: readonly ValueType[],
  callArgs: readonly number[],
) {
  const module = wasmImportRun("wasi_snapshot_preview1", importName, params, results);
  const child = createChildWasi({ module, syscalls, args, env });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  expect(await child.run(guestRun(instance), ...callArgs)).toBe(0);
  return { instance };
}

function guestRun(instance: WebAssembly.Instance): WebAssembly.ExportValue {
  const run = instance.exports.run;
  if (typeof run !== "function") throw new Error("Guest run export is missing");
  return run;
}

function guestMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory export is missing");
  return memory;
}

function regionBounds(request: Pick<KernelSyscallRequest, "regions">) {
  return request.regions.map(({ pointer, bytes }) => [pointer, bytes.byteLength]);
}

function stringVector(
  memory: WebAssembly.Memory,
  tablePointer: number,
  bufferPointer: number,
  count: number,
) {
  const view = new DataView(memory.buffer);
  const decoder = new TextDecoder();
  const strings: string[] = [];
  let expectedPointer = bufferPointer;
  for (let index = 0; index < count; index++) {
    const pointer = view.getUint32(tablePointer + index * 4, true);
    expect(pointer).toBe(expectedPointer);
    let end = pointer;
    while (end < memory.buffer.byteLength && new Uint8Array(memory.buffer)[end] !== 0) end++;
    expect(end).toBeLessThan(memory.buffer.byteLength);
    strings.push(decoder.decode(new Uint8Array(memory.buffer, pointer, end - pointer)));
    expectedPointer = end + 1;
  }
  return strings;
}

type ValueType = "i32" | "i64";

function wasmImportRun(
  namespace: string,
  importName: string,
  params: readonly ValueType[],
  results: readonly ValueType[],
) {
  const body = [0, ...params.flatMap((_, index) => [32, ...leb(index)]), 16, 0, 11];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, ...funcType(params, results)]),
      ...section(2, [1, ...name(namespace), ...name(importName), 0, 0]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("run"), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}

function wasmProcExit(code: number, exportName = "_start") {
  const body = [0, 65, ...leb(code, true), 16, 0, 11];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [2, ...funcType(["i32"], []), ...funcType([], [])]),
      ...section(2, [1, ...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0, 0]),
      ...section(3, [1, 1]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name(exportName), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}

function wasmRunConstant(value: number) {
  const body = [0, 65, ...leb(value, true), 11];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, ...funcType([], ["i32"])]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("run"), 0, 0]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}

function funcType(params: readonly ValueType[], results: readonly ValueType[]) {
  const valueType = (value: ValueType) => (value === "i32" ? 127 : 126);
  return [
    96,
    ...leb(params.length),
    ...params.map(valueType),
    ...leb(results.length),
    ...results.map(valueType),
  ];
}

function name(value: string) {
  const encoded = [...bytes(value)];
  return [...leb(encoded.length), ...encoded];
}

function section(id: number, body: number[]) {
  return [id, ...leb(body.length), ...body];
}

function leb(value: number, signed = false): number[] {
  const output: number[] = [];
  for (;;) {
    const byte = value & 127;
    value = signed ? value >> 7 : value >>> 7;
    const done = signed
      ? (value === 0 && (byte & 64) === 0) || (value === -1 && (byte & 64) !== 0)
      : value === 0;
    output.push(byte | (done ? 0 : 128));
    if (done) return output;
  }
}
