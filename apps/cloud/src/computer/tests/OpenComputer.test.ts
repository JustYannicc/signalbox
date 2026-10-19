import { describe, expect, it, vi } from "vite-plus/test";
import type { ComputerBindings } from "../OpenComputer.ts";
import { createComputerFactory } from "../OpenComputer.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

function bindings(files: ComputerBindings["files"]): ComputerBindings {
  return {
    files,
    exec: vi.fn(),
    port: vi.fn(),
    save: vi.fn(),
  };
}

describe("createComputerFactory", () => {
  it("reuses one Computer and file identity for its owning thread", async () => {
    const fixture = createTestFilesystem();
    const ports = bindings(fixture.filesystem);
    const bind = vi.fn(async () => ports);
    const computer = createComputerFactory(bind);
    const signal = new AbortController().signal;
    try {
      const [first, second] = await Promise.all([
        computer.open("thread-a", signal),
        computer.open("thread-a", signal),
      ]);

      expect(first).toBe(second);
      expect(first.files).toBe(fixture.filesystem);
      expect(first).toMatchObject({
        exec: ports.exec,
        port: ports.port,
        save: ports.save,
      });
      expect(bind).toHaveBeenCalledOnce();
      await expect(computer.open("thread-b", signal)).rejects.toThrow(
        "Computer belongs to another thread",
      );
      expect(bind).toHaveBeenCalledOnce();
    } finally {
      fixture.close();
    }
  });

  it("allows retry after the initial bind fails", async () => {
    const fixture = createTestFilesystem();
    const ports = bindings(fixture.filesystem);
    const failure = new Error("bind failed");
    let attempts = 0;
    const bind = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw failure;
      return ports;
    });
    const computer = createComputerFactory(bind);
    const signal = new AbortController().signal;
    try {
      await expect(computer.open("thread-a", signal)).rejects.toBe(failure);
      const opened = await computer.open("thread-a", signal);

      expect(opened.files).toBe(fixture.filesystem);
      expect(bind).toHaveBeenCalledTimes(2);
    } finally {
      fixture.close();
    }
  });

  it("keeps shared bindings alive when the first caller cancels", async () => {
    const fixture = createTestFilesystem();
    const ports = bindings(fixture.filesystem);
    const ready = Promise.withResolvers<void>();
    const started = Promise.withResolvers<AbortSignal>();
    const owner = new AbortController();
    const caller = new AbortController();
    const bind = vi.fn(async (_thread: string, signal: AbortSignal) => {
      started.resolve(signal);
      await ready.promise;
      signal.throwIfAborted();
      return ports;
    });
    const factory = createComputerFactory(bind);
    const failure = new Error("caller stopped waiting");
    try {
      const cancelled = factory.open("thread-a", caller.signal);
      const cancellation = expect(cancelled).rejects.toBe(failure);
      const bindingSignal = await started.promise;
      const other = factory.open("thread-a", owner.signal);
      caller.abort(failure);
      await cancellation;
      expect(bindingSignal.aborted).toBe(false);
      ready.resolve();
      expect((await other).files).toBe(fixture.filesystem);
      expect(bind).toHaveBeenCalledOnce();
    } finally {
      ready.resolve();
      fixture.close();
    }
  });

  it("cancels every pending open when its owner stops", async () => {
    const fixture = createTestFilesystem();
    const ready = Promise.withResolvers<ComputerBindings>();
    const started = Promise.withResolvers<AbortSignal>();
    const owner = new AbortController();
    const bind = vi.fn(async (_thread: string, signal: AbortSignal) => {
      started.resolve(signal);
      return ready.promise;
    });
    const factory = createComputerFactory(bind, owner.signal);
    const failure = new Error("owner stopped");
    const signal = new AbortController().signal;
    try {
      const first = expect(factory.open("thread-a", signal)).rejects.toBe(failure);
      const bindingSignal = await started.promise;
      const second = expect(factory.open("thread-a", signal)).rejects.toBe(failure);
      owner.abort(failure);
      await Promise.all([first, second]);
      expect(bindingSignal).toBe(owner.signal);
      await expect(factory.open("thread-a", signal)).rejects.toBe(failure);
      expect(bind).toHaveBeenCalledOnce();
    } finally {
      ready.resolve(bindings(fixture.filesystem));
      fixture.close();
    }
  });
});
