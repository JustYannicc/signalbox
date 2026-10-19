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
});
