// @effect-diagnostics nodeBuiltinImport:off - exercises the same Node stream adapter as the harness runtime.
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../isolate/NodeFs.ts";
import { createKernelProcessStreams } from "./KernelProcessStreams.ts";
import {
  bytes,
  setup,
  spawn,
  readAll,
  wasmFdReadWriteCommand,
} from "./tests/kernelProgramPipeFixture.ts";

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
