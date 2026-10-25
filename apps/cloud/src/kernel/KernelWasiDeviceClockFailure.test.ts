import { describe, expect, it } from "vite-plus/test";
import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import { KernelCpuExecution } from "./KernelCpuExecution.ts";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { OUTPUT, openDevice, wasiDeviceFixture } from "./tests/wasiDeviceFixture.ts";

describe("WASI device allocation ownership", () => {
  it.each([false, true])(
    "releases an unpublished device when the clock fails, persistent=%s",
    async (persistent) => {
      const fixture = wasiDeviceFixture();
      const table = fixture.filesystem.descriptors;
      const open = await fixture.syscall("path_open");
      const before = [...table.entries()].map(([fd]) => fd);
      const failure = new Error("device open clock failed");
      let armed = false;
      let failed = false;
      const execution = new KernelCpuExecution(
        new KernelCpuAccounting(() => {
          if (armed && [...table.entries()].length > before.length) failed = true;
          if (failed) {
            if (!persistent) failed = false;
            throw failure;
          }
          return 0n;
        }),
      );
      try {
        open.view().setUint32(OUTPUT, 123456, true);
        armed = true;
        await expect(execution.root.run(() => openDevice(open, "dev/null", 0n))).rejects.toBe(
          failure,
        );
        armed = false;
        failed = false;
        expect(open.view().getUint32(OUTPUT, true)).toBe(123456);
        expect([...table.entries()].map(([fd]) => fd)).toEqual(before);
      } finally {
        armed = false;
        failed = false;
        execution.root.stop();
        await fixture.close();
      }
    },
  );

  it("releases a file's inode pin when open cannot return its descriptor", async () => {
    const fixture = wasiDeviceFixture();
    const { filesystem, storage } = fixture;
    const initial = filesystem.open("/owned", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
    const inode = filesystem.descriptors.get(initial).inode;
    if (inode === undefined) throw new Error("Expected a stored file");
    filesystem.close(initial);
    const before = [...filesystem.descriptors.entries()].map(([fd]) => fd);
    const failure = new Error("file open clock failed");
    let armed = false;
    const execution = new KernelCpuExecution(
      new KernelCpuAccounting(() => {
        if (armed && [...filesystem.descriptors.entries()].length > before.length) throw failure;
        return 0n;
      }),
    );
    try {
      armed = true;
      let caught: unknown;
      try {
        execution.root.run(() => filesystem.open("/owned", KernelOpenFlags.O_RDONLY));
      } catch (error) {
        caught = error;
      }
      armed = false;
      expect(caught).toBe(failure);
      expect([...filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(before);
      filesystem.unlink("/owned");
      expect(() => storage.stat(inode)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      armed = false;
      execution.root.stop();
      await fixture.close();
    }
  });
});
