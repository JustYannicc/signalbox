// @effect-diagnostics nodeBuiltinImport:off - exercises the same Node stream adapter as the harness runtime.
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type KernelHandle,
} from "./KernelAbi.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import {
  KernelProgramHost,
  type KernelPipedProgram,
  type KernelProgramBinding,
} from "./KernelProgramHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { createNodeFs } from "../isolate/NodeFs.ts";
import { createKernelProcessStreams } from "./KernelProcessStreams.ts";

const now = () => 1_800_000_000_000_000_001n;
const bytes = (value: string) => new TextEncoder().encode(value);

function setup(
  implementation: KernelProgramBinding["implementation"],
  wakes = new KernelWakeRegistry(),
) {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, now) }],
  });
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "tool",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"] as const,
    entrypoint: "tool",
  };
  if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/tool", { manifest, implementation } satisfies KernelProgramBinding]]),
  });

  return {
    host,
    filesystem,
    wakes,
    fixture,
    async close(piped?: KernelPipedProgram) {
      await piped?.prepared.release();
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

function spawn(host: KernelProgramHost, piped: KernelPipedProgram): KernelHandle<"process"> {
  const program = host.resolve("/bin/tool");
  if (program.status !== "ok") throw new Error("Program resolution failed");
  const result = callKernel(host.backend(piped.prepared), "process.spawn", {
    program: program.value,
    args: [],
    env: {},
  });
  if (result.status !== "ok") throw new Error("Program admission failed");
  return result.value;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe("KernelProgramPipes", () => {
  it("terminates a WASI writer with SIGPIPE when its stdout reader closes", async () => {
    const context = setup({ kind: "wasm", module: wasmFdReadWriteCommand(4) });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      await piped.stdout.cancel();
      const input = piped.stdin.getWriter();
      await input.write(bytes("wasm"));
      await input.close();
      input.releaseLock();
      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toEqual({
        status: "ok",
        value: { exitCode: 0, signal: 13, coreDumped: false },
      });
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("keeps a Node writer alive after writeSync reports EPIPE", async () => {
    const context = setup({
      kind: "javascript",
      runInline: ({ filesystem }) => {
        const node = createNodeFs(filesystem).fs;
        expect(() => node.writeSync(1, bytes("node"))).toThrow(
          expect.objectContaining({ code: "EPIPE" }),
        );
        node.writeSync(2, bytes("survived"));
        return 42;
      },
    });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      await piped.stdout.cancel();
      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toEqual({
        status: "ok",
        value: { exitCode: 42, signal: 0, coreDumped: false },
      });
      expect(new TextDecoder().decode(await readAll(piped.stderr))).toBe("survived");
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("keeps a Node logical process alive after its stream emits EPIPE", async () => {
    const context = setup({
      kind: "async",
      run: async ({ filesystem, signal }) => {
        const streams = createKernelProcessStreams(filesystem, { signal });
        const stream = NodeStream.Writable.fromWeb(
          streams.stdout as NodeStreamWeb.WritableStream<Uint8Array>,
        );
        const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
        const closed = new Promise<void>((resolve) => stream.once("close", resolve));
        stream.end(bytes("node"));
        expect(await failed).toMatchObject({ code: "EPIPE" });
        await closed;
        expect(signal.aborted).toBe(false);
        const stderr = streams.stderr.getWriter();
        await stderr.write(bytes("survived"));
        stderr.releaseLock();
        return { exitCode: 42, signal: 0, coreDumped: false };
      },
    });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      await piped.stdout.cancel();
      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toEqual({
        status: "ok",
        value: { exitCode: 42, signal: 0, coreDumped: false },
      });
      expect(new TextDecoder().decode(await readAll(piped.stderr))).toBe("survived");
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("runs synchronous JS tools against piped stdin, stdout, and stderr", async () => {
    const context = setup({
      kind: "javascript",
      runInline: ({ filesystem }) => {
        const input = new Uint8Array(64);
        const count = filesystem.read(0, input, null);
        const text = new TextDecoder().decode(input.subarray(0, count));
        filesystem.write(1, bytes(`out:${text}`), null);
        filesystem.write(2, bytes(`err:${text}`), null);
        return 0;
      },
    });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      const input = piped.stdin.getWriter();
      await input.write(bytes("hello"));
      await input.close();
      input.releaseLock();

      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 0, coreDumped: false },
      });
      expect(new TextDecoder().decode(await readAll(piped.stdout))).toBe("out:hello");
      expect(new TextDecoder().decode(await readAll(piped.stderr))).toBe("err:hello");
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("returns EAGAIN when synchronous output reaches pipe capacity", async () => {
    const context = setup({
      kind: "javascript",
      runInline: ({ filesystem }) => {
        filesystem.write(1, new Uint8Array(65_536), null);
        try {
          filesystem.write(1, Uint8Array.of(1), null);
          return 0;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EAGAIN") return 42;
          throw error;
        }
      },
    });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      const child = spawn(context.host, piped);
      expect(await context.host.exitStatus(child)).toMatchObject({
        status: "ok",
        value: { exitCode: 42, signal: 0, coreDumped: false },
      });
      expect(await readAll(piped.stdout)).toEqual(new Uint8Array(65_536));
      expect(await readAll(piped.stderr)).toEqual(new Uint8Array());
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("suspends asynchronous WASM stdin reads until the caller writes data", async () => {
    const context = setup({ kind: "wasm", module: wasmFdReadWriteCommand(4) });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    const entered = Promise.withResolvers<void>();
    const stdin = piped.prepared.filesystem.descriptors.get(0).stdio;
    if (!stdin?.readInto) throw new Error("Missing child stdin");
    const original = stdin.readInto;
    vi.spyOn(stdin, "readInto").mockImplementation((target, flags) => {
      const pending = original.call(stdin, target, flags);
      expect(pending).toBeInstanceOf(Promise);
      entered.resolve();
      return pending;
    });
    try {
      const child = spawn(context.host, piped);
      await entered.promise;
      expect(context.wakes.size).toBeGreaterThan(0);

      const input = piped.stdin.getWriter();
      await input.write(bytes("wasm"));
      await input.close();
      input.releaseLock();

      expect(await context.host.exitStatus(child)).toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 0, coreDumped: false },
      });
      expect(new TextDecoder().decode(await readAll(piped.stdout))).toBe("wasm");
      expect(await readAll(piped.stderr)).toEqual(new Uint8Array());
      expect(context.host.processes.reap(child).status).toBe("ok");
    } finally {
      await context.close(piped);
    }
  });

  it("runs synchronous WASM against already-ready piped stdin and output", async () => {
    const context = setup({ kind: "wasm", module: wasmFdReadWriteCommand(4) });
    const piped = context.host.preparePiped({ filesystem: context.filesystem });
    try {
      const resolved = context.host.resolve("/bin/tool");
      if (resolved.status !== "ok") throw new Error("Program resolution failed");
      const input = piped.stdin.getWriter();
      await input.write(bytes("sync"));
      await input.close();
      input.releaseLock();

      expect(context.host.runInline(piped.prepared, resolved.value, [], {})).toBe(0);
      expect(new TextDecoder().decode(await readAll(piped.stdout))).toBe("sync");
      expect(await readAll(piped.stderr)).toEqual(new Uint8Array());
    } finally {
      await context.close(piped);
    }
  });
});

function wasmFdReadWriteCommand(readLength: number): WebAssembly.Module {
  const body = [
    0, 0x41, 0, 0x41, 0, 0x41, 1, 0x41, 8, 0x10, 0, 0x04, 0x40, 0x41, 17, 0x10, 2, 0x00, 0x0b, 0x41,
    1, 0x41, 0, 0x41, 1, 0x41, 12, 0x10, 1, 0x04, 0x40, 0x41, 18, 0x10, 2, 0x00, 0x0b, 0x0b,
  ];
  const memory = new Uint8Array(16 + readLength);
  const view = new DataView(memory.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, readLength, true);
  const data = [0, 0x41, 0, 0x0b, ...leb(memory.byteLength), ...memory];

  return new WebAssembly.Module(
    new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      ...section(2, [
        3,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_read"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_write"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("proc_exit"),
        0,
        1,
      ]),
      ...section(3, [1, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 3]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, ...data]),
    ]),
  );
}

function section(id: number, content: readonly number[]): number[] {
  return [id, ...leb(content.length), ...content];
}

function name(value: string): number[] {
  const encoded = [...new TextEncoder().encode(value)];
  return [...leb(encoded.length), ...encoded];
}

function leb(value: number): number[] {
  const encoded: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>>= 7;
    encoded.push(byte | (value === 0 ? 0 : 0x80));
    if (value === 0) return encoded;
  }
}
