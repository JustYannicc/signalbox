import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem, type WasiStdio } from "../../kernel/KernelFileSystem.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import type { KernelSyscallPort, KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import {
  KernelProcessTable,
  type KernelExitStatus,
  type KernelProcessIdentity,
} from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import type { KernelWasiSignalOptions } from "../../kernel/KernelWasiFileSystemAdapter.ts";
import { ChildWasiExit, createChildWasi } from "../ChildWasi.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("ChildWasi", () => {
  it("bounds a large EOF iovec before copying and returns no unchanged payload", async () => {
    const fixture = harness({ stdio: [{ readInto: () => 0 }, {}, {}] });
    const module = wasmImportRun(
      "wasi_snapshot_preview1",
      "fd_read",
      ["i32", "i32", "i32", "i32"],
      ["i32"],
    );
    let responseBytes = -1;
    const child = createChildWasi({
      module,
      args: [],
      env: {},
      syscalls: {
        async call(request) {
          const response = await fixture.syscalls.call(request);
          responseBytes =
            response.kind === "return"
              ? response.regions.reduce((size, region) => size + region.bytes.length, 0)
              : 0;
          return response;
        },
      },
    });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);
    const memory = guestMemory(instance);
    memory.grow(1279);
    const view = new DataView(memory.buffer);
    view.setUint32(32, 1024, true);
    view.setUint32(36, 64 * 1024 * 1024, true);
    new Uint8Array(memory.buffer)[1024 + 64 * 1024 * 1024 - 1] = 255;
    try {
      expect(await child.run(guestRun(instance), 0, 32, 1, 16)).toBe(0);
      const requestBytes = fixture.requests[0]!.regions.reduce(
        (size, region) => size + region.bytes.length,
        0,
      );
      expect(requestBytes).toBe(8);
      expect(responseBytes).toBe(4);
      expect(view.getUint32(16, true)).toBe(0);
      expect(new Uint8Array(memory.buffer)[1024 + 64 * 1024 * 1024 - 1]).toBe(255);
    } finally {
      fixture.filesystem.dispose();
    }
  });

  it("validates uncopied iovec suffixes after the descriptor rights check", async () => {
    let reads = 0;
    const fixture = harness({
      stdio: [
        {
          readInto: () => {
            reads++;
            return 0;
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
    const child = createChildWasi({ module, syscalls: fixture.syscalls, args: [], env: {} });
    const instance = new WebAssembly.Instance(module, child.imports);
    child.bind(instance);
    const memory = guestMemory(instance);
    memory.grow(300);
    const view = new DataView(memory.buffer);
    view.setUint32(32, 1024, true);
    view.setUint32(36, 16 * 1024 * 1024, true);
    view.setUint32(40, memory.buffer.byteLength - 1, true);
    view.setUint32(44, 2, true);
    try {
      expect(await child.run(guestRun(instance), 1, 32, 2, 16)).toBe(76);
      const result = await child.run(guestRun(instance), 0, 32, 2, 16);
      expect(result).toBe(21);
      expect(reads).toBe(0);
    } finally {
      fixture.filesystem.dispose();
    }
  });

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

  it.each([
    ["default", "reader-close"],
    ["ignored", "reader-close"],
    ["blocked", "reader-close"],
    ["ignored", "abort"],
    ["ignored", "dispose"],
    ["ignored", "writer-close"],
  ] as const)(
    "reports partial ChildWasi writes with %s SIGPIPE and %s",
    async (sigpipe, interruption) => {
      const wakes = new KernelWakeRegistry();
      const pipe = new KernelPipe(wakes);
      const completion = Promise.withResolvers<KernelExitStatus>();
      const controller = new AbortController();
      const processes = new KernelProcessTable({ wakes });
      let identity: KernelProcessIdentity | undefined;
      const spawned = processes.spawn(
        undefined,
        (candidate) => {
          identity = candidate;
          return {
            completion: completion.promise,
            signal: () => ({ status: "ok" as const, value: undefined }),
          };
        },
        () => {},
      );
      if (spawned.status !== "ok" || identity === undefined) {
        throw new Error("Could not create the signal owner process");
      }
      const handle = identity.handle;
      if (sigpipe === "ignored") {
        expect(processes.setSigpipeDisposition(handle, "epipe").status).toBe("ok");
      }
      if (sigpipe === "blocked") {
        expect(processes.signalMask(handle, 0, { low: 4096, high: 0 }).status).toBe("ok");
      }

      const fixture = harness({
        stdio: [
          {},
          { write: (source) => pipe.writeBlocking(source, { signal: controller.signal }) },
          {},
        ],
        process: { identity, processes },
      });
      const module = wasmFdWrite();
      const child = createChildWasi({
        module,
        syscalls: fixture.syscalls,
        args: [],
        env: {},
      });
      const instance = new WebAssembly.Instance(module, child.imports);
      child.bind(instance);
      const memory = guestMemory(instance);
      memory.grow(16);
      const view = new DataView(memory.buffer);
      view.setUint32(32, 128, true);
      view.setUint32(36, 1_048_576, true);
      view.setUint32(16, 0, true);
      new Uint8Array(memory.buffer, 128, 1_048_576).fill(0xa7);

      pipe.tryWrite(new Uint8Array(65_536).fill(0xee));
      let pending: Promise<unknown> | undefined;
      const refilled = Promise.withResolvers<void>();
      const unsubscribe = pipe.subscribe("read")(() => refilled.resolve());
      try {
        pending = child.run(guestRun(instance));
        pipe.tryReadInto(new Uint8Array(4));
        await refilled.promise;
        unsubscribe();
        if (interruption === "reader-close") pipe.closeReader();
        else if (interruption === "abort") controller.abort();
        else if (interruption === "dispose") wakes.dispose();
        else pipe.closeWriter();

        if (sigpipe === "default") {
          await expect(pending).rejects.toMatchObject({ signal: 13 });
          expect(view.getUint32(16, true)).toBe(0);
        } else {
          expect(await pending).toBe(0);
          expect(view.getUint32(16, true)).toBe(4);
          if (interruption === "reader-close") {
            expect(await child.run(guestRun(instance))).toBe(64);
          }
          if (sigpipe === "blocked") {
            expect(() => processes.signalMask(handle, 1, { low: 4096, high: 0 })).toThrow(
              expect.objectContaining({ signal: 13 }),
            );
          }
        }
      } finally {
        unsubscribe();
        pipe.closeReader();
        pipe.closeWriter();
        completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
        await pending?.catch(() => undefined);
        fixture.host.close();
        fixture.filesystem.dispose();
        await processes.dispose();
        wakes.dispose();
      }
    },
  );

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
});

interface HarnessOptions {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdio?: readonly [WasiStdio, WasiStdio, WasiStdio];
  readonly process?: KernelWasiSignalOptions["process"];
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
    ...(options.process === undefined ? {} : { process: options.process }),
  });
  const requests: KernelSyscallRequest[] = [];
  const syscalls: KernelSyscallPort = {
    async call(request) {
      requests.push({
        ...request,
        regions: request.regions.map((region) => ({ ...region, bytes: region.bytes.slice() })),
      });
      return host.call(request);
    },
  };
  return { filesystem, requests, syscalls, host };
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
  return request.regions.map(({ pointer, bytes, length }) => [pointer, length ?? bytes.byteLength]);
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

function wasmFdWrite() {
  const body = [0, 65, 1, 65, 32, 65, 1, 65, 16, 16, 0, 11];
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
      ...section(1, [
        2,
        ...funcType(["i32", "i32", "i32", "i32"], ["i32"]),
        ...funcType([], ["i32"]),
      ]),
      ...section(2, [1, ...name("wasi_snapshot_preview1"), ...name("fd_write"), 0, 0]),
      ...section(3, [1, 1]),
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
