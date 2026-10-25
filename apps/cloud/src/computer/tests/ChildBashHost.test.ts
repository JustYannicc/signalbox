import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramExecAdmissionError } from "../../kernel/KernelAsyncProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { childBashFixture, exited, text } from "./ChildBashFixture.ts";

const call = (port: KernelBashPort, name: string, args: readonly number[]) =>
  port.callBash({ namespace: "nimbus_proc", name, args, memorySize: 65_536, regions: [] });

describe("GNU Bash facet host", () => {
  it("handles metadata at the end of a 4 GiB guest address space using only supplied ABI bytes", async () => {
    const fixture = childBashFixture();
    const path = text("/workspace");
    const pointer = 0xffff_ffe0;
    try {
      const result = await fixture.owner.port.callBash({
        namespace: "nimbus_proc",
        name: "stat_metadata",
        args: [-1, 64, path.length, 1, pointer],
        memorySize: 0x1_0000_0000,
        regions: [
          { pointer: 64, bytes: path },
          { pointer, bytes: new Uint8Array(12) },
        ],
      });
      expect(result.value).toBe(0);
      expect(result.regions).toHaveLength(1);
      expect(result.regions[0]!.pointer).toBe(pointer);
      const view = new DataView(result.regions[0]!.bytes.buffer);
      expect([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)]).toEqual([
        0o040755, 1000, 1000,
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("shares open-file offsets across fork while keeping cwd and descriptor lifetime separate", async () => {
    const fixture = childBashFixture();
    fixture.write("input", "abcdef");
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_RDONLY);
    const child = await fixture.owner.port.fork();
    if (child.kind !== "fork") throw new Error("Fork failed");
    try {
      const iovecs = new Uint8Array(8);
      const table = new DataView(iovecs.buffer);
      table.setUint32(0, 128, true);
      table.setUint32(4, 2, true);
      const read = await child.port.call({
        name: "fd_read",
        args: [fd, 32, 1, 16],
        memorySize: 65_536,
        regions: [
          { pointer: 16, bytes: new Uint8Array(4) },
          { pointer: 32, bytes: iovecs },
          { pointer: 128, bytes: new Uint8Array(2) },
        ],
      });
      expect(read).toMatchObject({ kind: "return", value: 0 });
      const next = new Uint8Array(2);
      expect(fixture.filesystem.read(fd, next, null)).toBe(2);
      expect(new TextDecoder().decode(next)).toBe("cd");
      const cwd = text("/workspace/nested");
      expect(
        await child.port.callBash({
          namespace: "nimbus_proc",
          name: "capture_cwd",
          args: [64, cwd.length],
          memorySize: 65_536,
          regions: [{ pointer: 64, bytes: cwd }],
        }),
      ).toMatchObject({ value: 0 });
      expect(fixture.filesystem.cwd).toBe("/workspace");
      expect(
        await child.port.call({ name: "fd_close", args: [fd], memorySize: 65_536, regions: [] }),
      ).toMatchObject({ kind: "return", value: 0 });
      expect(fixture.filesystem.descriptors.has(fd)).toBe(true);
      await child.port.complete({ kind: "exit", status: exited(7) });
      expect(await fixture.owner.port.wait(child.pid, 0)).toEqual({
        kind: "wait",
        pid: child.pid,
        status: exited(7),
      });
      expect(await fixture.owner.port.wait(child.pid, 0)).toEqual({ kind: "error", errno: 12 });
      expect(fixture.processes.size).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("reports nonblocking wait and signals a live fork without fabricating early completion", async () => {
    const fixture = childBashFixture();
    const child = await fixture.owner.port.fork();
    if (child.kind !== "fork") throw new Error("Fork failed");
    try {
      expect(await fixture.owner.port.wait(child.pid, 1)).toEqual({ kind: "wait", pid: 0 });
      expect((await call(fixture.owner.port, "kill", [child.pid, 9])).value).toBe(0);
      expect(await fixture.owner.port.wait(child.pid, 1)).toEqual({ kind: "wait", pid: 0 });
      await expect(call(child.port, "getppid", [])).rejects.toThrow();
      await child.port.complete({ kind: "failure", message: "observed abort" });
      expect(await fixture.owner.port.wait(child.pid, 0)).toEqual({
        kind: "wait",
        pid: child.pid,
        status: { exitCode: 0, signal: 9, coreDumped: false },
      });
    } finally {
      await fixture.close();
    }
  });

  it("refuses fork at process capacity without leaking copied descriptors", async () => {
    const fixture = childBashFixture({ maxProcesses: 1 });
    const before = [...fixture.filesystem.descriptors.entries()].length;
    try {
      expect(await fixture.owner.port.fork()).toEqual({ kind: "error", errno: 6 });
      expect(fixture.processes.size).toBe(1);
      expect([...fixture.filesystem.descriptors.entries()]).toHaveLength(before);
    } finally {
      await fixture.close();
    }
  });

  it("reaps an unconsumed fork when its dispatch is closed and leaves the caller's resources alive", async () => {
    const fixture = childBashFixture();
    const child = await fixture.owner.port.fork();
    if (child.kind !== "fork") throw new Error("Fork failed");
    try {
      await child.port.complete({ kind: "exit", status: exited() });
      await fixture.owner.close();
      expect(fixture.processes.size).toBe(1);
      expect(fixture.filesystem.descriptors.has(1)).toBe(true);
      expect(fixture.filesystem.cwd).toBe("/workspace");
      await expect(call(child.port, "dup", [1])).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("distinguishes exec admission rejection from a replacement failure after admission", async () => {
    let admitted = false;
    const fixture = childBashFixture({
      exec: async () => {
        if (!admitted) throw new KernelProgramExecAdmissionError("EACCES", "rejected");
        throw new Error("replacement failed");
      },
    });
    const request = { path: "/bin/external", args: ["caller-zero"], env: { EXACT: "yes" } };
    try {
      expect(await fixture.owner.port.exec(request)).toEqual({ kind: "error", errno: 2 });
      admitted = true;
      await expect(fixture.owner.port.exec(request)).rejects.toThrow("replacement failed");
    } finally {
      await fixture.close();
    }
  });
});
