import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerProgram, type ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function withContext(run: (context: KernelAsyncProgramContext) => Promise<void>) {
  const fixture = createTestFilesystem();
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const identity = processes.spawn(
    undefined,
    () => ({
      completion: Promise.resolve({ exitCode: 0, signal: 0, coreDumped: false }),
      signal: () => ({ status: "ok", value: undefined }),
    }),
    () => {},
  );
  if (identity.status !== "ok") throw new Error("Process admission failed");
  try {
    await run({
      filesystem: fixture.filesystem,
      home: undefined,
      args: ["custom argv0", "space arg", "雪"],
      env: { EXACT: "雪", EMPTY: "" },
      identity: identity.value,
      signal: new AbortController().signal,
      processes,
      wakes,
      spawn: async () => {
        throw new Error("Unexpected nested spawn");
      },
      exec: async () => {
        throw new Error("Unexpected replacement exec");
      },
    });
  } finally {
    await processes.dispose();
    wakes.dispose();
    fixture.close();
  }
}

describe("ChildWorkerProgram", () => {
  it("releases a disconnected invocation only after both host cleanup and its late stop ACK", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const cleaned = deferred<void>();
      const stopped = deferred<void>();
      const failure = new ChildWorkerDispatchError(new Error("RPC disconnected"), {
        kind: "unconfirmed",
        stopped: stopped.promise,
      });
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: {
          run: async () => {
            throw failure;
          },
        },
        createHost: () => ({
          host: {},
          close() {
            cleaned.resolve();
          },
        }),
      });
      await expect(program.run(context)).rejects.toBe(failure);
      await cleaned.promise;
      expect(capacity.active).toBe(1);
      const drained = capacity.acquire(context.signal).then((permit) => permit.release());
      stopped.resolve();
      await drained;
      expect(capacity.active).toBe(0);
    }));

  it("retains admission when the stop ACK itself rejects", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const stopped = Promise.withResolvers<void>();
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: {
          run: async () => {
            throw new ChildWorkerDispatchError("RPC disconnected", {
              kind: "unconfirmed",
              stopped: stopped.promise,
            });
          },
        },
        createHost: () => ({ host: {}, close() {} }),
      });
      await expect(program.run(context)).rejects.toMatchObject({ code: "CLEANUP_UNCONFIRMED" });
      stopped.reject(new Error("ACK transport lost too"));
      await expect(stopped.promise).rejects.toThrow("ACK transport lost too");
      expect(capacity.active).toBe(1);
      expect(capacity.tryAcquire(context.signal)).toBeUndefined();
    }));

  it("retains admission after a disconnected dispatch even after host cleanup finishes", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const closing = deferred<void>();
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: {
          run: async () => {
            throw new Error("RPC disconnected");
          },
        },
        createHost: () => ({
          host: {},
          close() {
            closing.resolve();
          },
        }),
      });
      await expect(program.run(context)).rejects.toMatchObject({
        code: "CLEANUP_UNCONFIRMED",
        message: "RPC disconnected",
      });
      await closing.promise;
      expect(capacity.active).toBe(1);
      expect(capacity.tryAcquire(context.signal)).toBeUndefined();
    }));

  it("returns logical exit while retaining admission through a late dispatch failure and gated close", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const exited = Promise.withResolvers<{
        exitCode: number;
        signal: number;
        coreDumped: boolean;
      }>();
      const dispatched = Promise.withResolvers<never>();
      const closing = deferred<void>();
      const closed = Promise.withResolvers<void>();
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: { run: () => dispatched.promise },
        createHost: () => ({
          host: {},
          exited: exited.promise,
          async close() {
            closing.resolve();
            await closed.promise;
          },
        }),
      });
      const result = program.run(context);
      const status = { exitCode: 17, signal: 0, coreDumped: false };
      exited.resolve(status);
      expect(await result).toEqual(status);
      expect(capacity.active).toBe(1);
      dispatched.reject(
        new ChildWorkerDispatchError(new Error("Late dispatch failure"), { kind: "stopped" }),
      );
      await closing.promise;
      expect(capacity.active).toBe(1);
      const drained = capacity.acquire(context.signal).then((permit) => permit.release());
      closed.reject(new Error("Late close failure"));
      await drained;
      expect(capacity.active).toBe(0);
      expect(await result).toEqual(status);
    }));

  it("reports dispatch failure before logical exit even while physical close remains blocked", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const exited = Promise.withResolvers<{
        exitCode: number;
        signal: number;
        coreDumped: boolean;
      }>();
      const dispatched = Promise.withResolvers<never>();
      const closing = deferred<void>();
      const closed = Promise.withResolvers<void>();
      const failure = new ChildWorkerDispatchError(new Error("Dispatch failed before exit"), {
        kind: "stopped",
      });
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: { run: () => dispatched.promise },
        createHost: () => ({
          host: {},
          exited: exited.promise,
          async close() {
            closing.resolve();
            await closed.promise;
          },
        }),
      });
      const result = program.run(context);
      const rejected = expect(result).rejects.toBe(failure);
      dispatched.reject(failure);
      await closing.promise;
      await rejected;
      exited.resolve({ exitCode: 17, signal: 0, coreDumped: false });
      expect(capacity.active).toBe(1);
      const drained = capacity.acquire(context.signal).then((permit) => permit.release());
      closed.reject(new Error("Close also failed"));
      await drained;
      expect(capacity.active).toBe(0);
      await expect(result).rejects.toBe(failure);
    }));

  it("reports a closing failure when no logical exit was published", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const exited = Promise.withResolvers<{
        exitCode: number;
        signal: number;
        coreDumped: boolean;
      }>();
      const closing = deferred<void>();
      const closed = Promise.withResolvers<void>();
      const failure = new Error("Close failed before logical exit");
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: { run: async () => ({ exitCode: 17, signal: 0, coreDumped: false }) },
        createHost: () => ({
          host: {},
          exited: exited.promise,
          async close() {
            closing.resolve();
            await closed.promise;
          },
        }),
      });
      const result = program.run(context);
      const rejected = expect(result).rejects.toBe(failure);
      await closing.promise;
      expect(capacity.active).toBe(1);
      closed.reject(failure);
      await rejected;
      expect(capacity.active).toBe(0);
      exited.reject(new Error("Owner also failed"));
    }));

  it("captures code and exact command while keeping process resources at the owner", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity();
      const wasm = new Uint8Array([0, 97, 115, 109]);
      const modules = { "entry.js": "original", "tool.wasm": { wasm: wasm.buffer } };
      const host = { identity: context.identity };
      const close = vi.fn();
      const run = vi.fn(async (input: ChildWorkerInvocation, owner: typeof host) => {
        expect(capacity.active).toBe(1);
        expect(owner).toBe(host);
        expect(input.command).toEqual({
          executable: "/bin/tool",
          argv: context.args,
          cwd: "/",
          env: context.env,
        });
        expect(input.modules["entry.js"]).toBe("original");
        const module = input.modules["tool.wasm"];
        if (!module || typeof module === "string" || !("wasm" in module))
          throw new Error("Wasm module missing");
        expect(new Uint8Array(module.wasm)).toEqual(Uint8Array.of(0, 97, 115, 109));
        return { exitCode: 17, signal: 0, coreDumped: false };
      });
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules },
        capacity,
        dispatch: { run },
        createHost: () => ({ host, close }),
      });
      modules["entry.js"] = "changed";
      wasm.fill(255);
      expect(await program.run(context)).toEqual({ exitCode: 17, signal: 0, coreDumped: false });
      expect(close).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(0);
    }));

  it("holds admission through actual dispatch and host close after cancellation", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity(1);
      const controller = new AbortController();
      const started = deferred<void>();
      const completed = deferred<void>();
      const closing = deferred<void>();
      const closed = deferred<void>();
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: {
          async run() {
            started.resolve();
            await completed.promise;
            return { exitCode: 0, signal: 0, coreDumped: false };
          },
        },
        createHost: () => ({
          host: {},
          async close() {
            closing.resolve();
            await closed.promise;
          },
        }),
      });
      const pending = program.run({ ...context, signal: controller.signal });
      await started.promise;
      controller.abort(new Error("cancelled"));
      expect(capacity.active).toBe(1);
      completed.resolve();
      await closing.promise;
      expect(capacity.active).toBe(1);
      closed.resolve();
      await pending;
      expect(capacity.active).toBe(0);
    }));

  it("closes the owner on dispatch failure and releases admission on setup failure", () =>
    withContext(async (context) => {
      const capacity = new ChildWorkerCapacity();
      const close = vi.fn();
      const failure = new ChildWorkerDispatchError(new Error("dispatch failed"), {
        kind: "stopped",
      });
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: {
          async run() {
            throw failure;
          },
        },
        createHost: () => ({ host: {}, close }),
      });
      await expect(program.run(context)).rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(0);
      const setup = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules: {} },
        capacity,
        dispatch: {
          async run() {
            throw new Error("must not dispatch");
          },
        },
        createHost() {
          throw failure;
        },
      });
      await expect(setup.run(context)).rejects.toBe(failure);
      expect(capacity.active).toBe(0);
    }));
});
