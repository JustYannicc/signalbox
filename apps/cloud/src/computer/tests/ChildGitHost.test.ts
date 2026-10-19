import { describe, expect, it } from "vite-plus/test";
import { kernelOk } from "../../kernel/KernelAbi.ts";
import type { KernelGitCall } from "../../kernel/KernelGitPort.ts";
import type { KernelMemoryRegion } from "../../kernel/KernelSyscallPort.ts";
import { childGitFixture, exited, text } from "./ChildGitFixture.ts";

const region = (pointer: number, value: Uint8Array): KernelMemoryRegion => ({
  pointer,
  bytes: value,
});
const sparseBytes = (regions: readonly KernelMemoryRegion[], pointer: number, length: number) => {
  const result = new Uint8Array(length);
  for (const item of regions) {
    const start = Math.max(pointer, item.pointer);
    const end = Math.min(pointer + length, item.pointer + item.bytes.byteLength);
    if (end > start)
      result.set(item.bytes.subarray(start - item.pointer, end - item.pointer), start - pointer);
  }
  return result;
};

describe("Git process host", () => {
  it("uses sparse stat ranges and validates the full guest pointer before touching the filesystem", async () => {
    const fixture = childGitFixture();
    fixture.write("known", "file");
    const path = text("known");
    const output = 0xffff_ffb0;
    const request: KernelGitCall = {
      namespace: "nimbus_fs",
      name: "path_stat",
      args: [-100, 1, 64, path.byteLength, output],
      memorySize: 0x1_0000_0000,
      regions: [region(64, path), region(output, new Uint8Array(80))],
    };
    try {
      const stat = await fixture.owner.port.callGit(request);
      expect(stat.value).toBe(0);
      const bytes = sparseBytes(stat.regions, output, 80);
      expect(new DataView(bytes.buffer).getUint32(64, true) & 0o170000).toBe(0o100000);
      expect(new DataView(bytes.buffer).getUint32(68, true)).toBe(1000);

      const invalid = await fixture.owner.port.callGit({
        ...request,
        args: [-100, 1, 64, path.byteLength, output + 1],
        regions: [region(64, path)],
      });
      expect(invalid.value).toBe(21);

      const missingRange = await fixture.owner.port.callGit({
        ...request,
        args: [-100, 1, 64, path.byteLength, 128],
        regions: [region(64, path)],
      });
      expect(missingRange.value).toBe(21);

      const cwdPointer = 0xffff_ffe0;
      const cwd = await fixture.owner.port.callGit({
        namespace: "nimbus_proc",
        name: "startup_cwd",
        args: [cwdPointer, 64],
        memorySize: 0x1_0000_0000,
        regions: [region(cwdPointer, new Uint8Array(32))],
      });
      expect(cwd.value).toBe(10);
      expect(sparseBytes(cwd.regions, cwdPointer, 11)).toEqual(
        Uint8Array.from([...text("/workspace"), 0]),
      );

      const argv = Uint8Array.from([...text("/bin/held"), 0]);
      const invalidSpawn = await fixture.owner.port.callGit({
        namespace: "nimbus_proc",
        name: "spawn",
        args: [16, argv.byteLength, 128, 0, 511, 2, -1, -1, -1, 256],
        memorySize: 512,
        regions: [region(16, argv), region(256, new Uint8Array(4))],
      });
      expect(invalidSpawn.value).toBe(21);
      expect(fixture.processes.size).toBe(1);

      const before = fixture.filesystem.posixPolicy!.umask;
      const missingUmaskOutput = await fixture.owner.port.callGit({
        namespace: "nimbus_fs",
        name: "umask",
        args: [0o077, 128],
        memorySize: 512,
        regions: [],
      });
      expect(missingUmaskOutput.value).toBe(21);
      expect(fixture.filesystem.posixPolicy!.umask).toBe(before);

      fixture.controller.abort(new Error("Git request cancelled"));
      await expect(
        fixture.owner.port.callGit({
          namespace: "nimbus_proc",
          name: "ids",
          args: [64],
          memorySize: 128,
          regions: [region(64, new Uint8Array(8))],
        }),
      ).rejects.toThrow("Git request cancelled");
    } finally {
      await fixture.close();
    }
  });

  it("waits for in-flight stdout I/O before closing the borrowed syscall host", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let written = 0;
    const fixture = childGitFixture({
      stdoutWrite: async (bytes) => {
        entered.resolve();
        await release.promise;
        written += bytes.byteLength;
        return bytes.byteLength;
      },
    });
    const payload = text("blocked");
    const iovecs = new Uint8Array(8);
    const view = new DataView(iovecs.buffer);
    view.setUint32(0, 128, true);
    view.setUint32(4, payload.byteLength, true);
    const pending = fixture.owner.port
      .call({
        name: "fd_write",
        args: [1, 32, 1, 16],
        memorySize: 256,
        regions: [region(16, new Uint8Array(4)), region(32, iovecs), region(128, payload)],
      })
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      let closed = false;
      const closing = fixture.owner.close().then(
        () => {
          closed = true;
        },
        (error: unknown) => {
          closed = true;
          throw error;
        },
      );
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      await pending;
      await closing;
      expect(closed).toBe(true);
      expect(written).toBe(payload.byteLength);
    } finally {
      release.resolve();
      await fixture.close();
    }
  });

  it("terminates and reaps Git children before releasing their owner port", async () => {
    let fixture: ReturnType<typeof childGitFixture>;
    let signalSeen = 0;
    let requestSeen: unknown;
    fixture = childGitFixture({
      spawn: async (request) => {
        requestSeen = request;
        const completion = Promise.withResolvers<ReturnType<typeof exited>>();
        const admitted = fixture.processes.spawn(
          fixture.context.identity.handle,
          () => ({
            completion: completion.promise,
            signal(signal: number) {
              signalSeen = signal;
              completion.resolve({ ...exited(128 + signal), signal });
              return kernelOk(undefined);
            },
          }),
          () => {},
        );
        return admitted.status === "ok" ? kernelOk(admitted.value.handle) : admitted;
      },
    });
    const argv = text("/bin/held\0");
    try {
      const spawned = await fixture.owner.port.callGit({
        namespace: "nimbus_proc",
        name: "spawn",
        args: [16, argv.byteLength, 128, 0, 160, 0, -1, -1, -1, 256],
        memorySize: 512,
        regions: [region(16, argv), region(256, new Uint8Array(4))],
      });
      expect(spawned.value).toBe(0);
      const pid = new DataView(sparseBytes(spawned.regions, 256, 4).buffer).getInt32(0, true);
      expect(
        await fixture.owner.port.callGit({
          namespace: "nimbus_proc",
          name: "start",
          args: [pid],
          memorySize: 512,
          regions: [],
        }),
      ).toMatchObject({ value: 0 });
      expect(requestSeen).toMatchObject({
        execPath: "/bin/held",
        argv: ["/bin/held"],
      });
      expect(fixture.processes.size).toBe(2);

      await fixture.owner.close();
      expect(signalSeen).toBe(9);
      expect(fixture.processes.size).toBe(1);
      await expect(
        fixture.owner.port.callGit({
          namespace: "nimbus_proc",
          name: "ids",
          args: [0],
          memorySize: 0,
          regions: [],
        }),
      ).rejects.toThrow("unavailable");
    } finally {
      await fixture.close();
    }
  });
});
