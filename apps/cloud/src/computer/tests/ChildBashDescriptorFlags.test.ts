import { describe, expect, it } from "vite-plus/test";
import { assertComputerForwardingSupported } from "../ComputerForwardedProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBashImports } from "../ChildBashImports.ts";
import { childBashFixture, exited } from "./ChildBashFixture.ts";

const call = (port: KernelBashPort, name: string, args: readonly number[]) =>
  port.callBash({ namespace: "nimbus_proc", name, args, memorySize: 65_536, regions: [] });

describe("GNU Bash descriptor flags", () => {
  it("carries scalar flag calls from a WASM child through the sparse port without copying memory", async () => {
    const fixture = childBashFixture();
    const regions: number[] = [];
    const port: KernelBashPort = {
      ...fixture.owner.port,
      async callBash(request) {
        regions.push(request.regions.length);
        return fixture.owner.port.callBash(structuredClone(request));
      },
    };
    try {
      const set = scalarImport(port, "fd_setfd", 2);
      const get = scalarImport(port, "fd_getflags", 1);
      expect(await set(1, 1)).toBe(0);
      expect(await get(1)).toBe(1);
      expect(await set(1, 0)).toBe(0);
      expect(await get(1)).toBe(0);
      expect(await set(999, 1)).toBe(-8);
      expect(await get(999)).toBe(-8);
      expect(regions).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a saved shell descriptor out of machine exec only while close-on-exec is set", async () => {
    const fixture = childBashFixture();
    const admission = () =>
      assertComputerForwardingSupported({
        kind: "exec",
        command: { executable: "/bin/grep", argv: ["grep", "-P", "x"], cwd: "/workspace", env: {} },
        baseCwd: "/workspace",
        actions: [],
        attributes: undefined,
        filesystem: fixture.filesystem,
        processes: fixture.processes,
        identity: fixture.context.identity,
        signal: fixture.controller.signal,
        target: { kind: "unsupported", code: "NOT_FOUND", message: "machine program" },
      });
    try {
      expect((await call(fixture.owner.port, "dup2", [1, 29])).value).toBe(29);
      expect(admission).toThrow("Machine cannot inherit extra descriptors");
      expect((await call(fixture.owner.port, "fd_setfd", [29, 1])).value).toBe(0);
      expect((await call(fixture.owner.port, "fd_getflags", [29])).value).toBe(1);
      expect(admission).not.toThrow();
      expect(fixture.filesystem.descriptors.has(29)).toBe(true);
      expect((await call(fixture.owner.port, "fd_setfd", [29, 0])).value).toBe(0);
      expect((await call(fixture.owner.port, "fd_getflags", [29])).value).toBe(0);
      expect(admission).toThrow("Machine cannot inherit extra descriptors");
    } finally {
      await fixture.close();
    }
  });

  it("copies flags on fork, clears them on dup, and preserves the legacy existence probe", async () => {
    const fixture = childBashFixture();
    try {
      await call(fixture.owner.port, "fd_setfd", [1, 1]);
      expect((await call(fixture.owner.port, "fd_getfd", [1])).value).toBe(0);
      const duplicate = (await call(fixture.owner.port, "dup", [1])).value;
      expect((await call(fixture.owner.port, "fd_getflags", [duplicate])).value).toBe(0);
      const child = await fixture.owner.port.fork();
      if (child.kind !== "fork") throw new Error("Fork failed");
      expect((await call(child.port, "fd_getflags", [1])).value).toBe(1);
      await call(child.port, "fd_setfd", [1, 0]);
      expect((await call(child.port, "fd_getflags", [1])).value).toBe(0);
      expect((await call(fixture.owner.port, "fd_getflags", [1])).value).toBe(1);
      await child.port.complete({ kind: "exit", status: exited() });
      await fixture.owner.port.wait(child.pid, 0);
      expect((await call(fixture.owner.port, "fd_getflags", [999])).value).toBe(-8);
      expect((await call(fixture.owner.port, "fd_setfd", [999, 1])).value).toBe(-8);
      expect((await call(fixture.owner.port, "fd_getfd", [999])).value).toBe(8);
    } finally {
      await fixture.close();
    }
  });
});

function scalarImport(port: KernelBashPort, name: string, count: number) {
  const encoded = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const body = [0, ...Array.from({ length: count }, (_, index) => [32, index]).flat(), 16, 0, 11];
  const module = new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 96, count, ...Array<number>(count).fill(127), 1, 127]),
      ...section(2, [1, ...encoded("nimbus_proc"), ...encoded(name), 0, 0]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...encoded("memory"), 2, 0, ...encoded("run"), 0, 1]),
      ...section(10, [1, body.length, ...body]),
    ]),
  );
  const imports = createChildBashImports({ module, port });
  const instance = new WebAssembly.Instance(module, imports.imports);
  imports.bind(instance);
  const wasm = WebAssembly as unknown as {
    promising(fn: (...args: number[]) => number): (...args: number[]) => Promise<number>;
  };
  return wasm.promising(instance.exports.run as (...args: number[]) => number);
}
