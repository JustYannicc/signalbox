import { describe, expect, it } from "vite-plus/test";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { KernelBusyboxCall, KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { busyboxCredentials, childBusyboxFixture, text } from "./ChildBusyboxFixture.ts";

const call = (
  port: KernelBusyboxPort,
  name: string,
  args: readonly number[],
  regions: KernelBusyboxCall["regions"] = [],
  memorySize = 65_536,
) => port.callBusybox({ name, args, regions, memorySize });

function viewAt(regions: KernelBusyboxCall["regions"], pointer: number, length: number) {
  const region = regions.find(
    (region) =>
      region.pointer <= pointer && region.pointer + region.bytes.length >= pointer + length,
  );
  if (region === undefined) throw new Error("Expected output region");
  return new DataView(
    region.bytes.buffer,
    region.bytes.byteOffset + pointer - region.pointer,
    length,
  );
}

describe("Nimbus BusyBox facet host", () => {
  it("writes metadata at the top of a 4 GiB address space without allocating a guest heap", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const path = text("/workspace");
    const out = 0xffff_fff0;
    try {
      const result = await call(
        owner.port,
        "stat_metadata",
        [-1, 32, path.length, 1, out],
        [
          { pointer: 32, bytes: path },
          { pointer: out, bytes: new Uint8Array(12) },
        ],
        0x1_0000_0000,
      );
      expect(result.value).toBe(0);
      expect(result.regions).toHaveLength(1);
      const view = viewAt(result.regions, out, 12);
      expect([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)]).toEqual([
        0o040755, 1000, 1000,
      ]);
      expect(path).toEqual(text("/workspace"));
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("keeps the identity fields and encoded umask on the real process filesystem", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect((await call(owner.port, "identity", [0])).value).toBe(1000);
      expect((await call(owner.port, "identity", [1])).value).toBe(1000);
      expect((await call(owner.port, "identity", [2])).value).toBe(fixture.context.identity.pid);
      expect((await call(owner.port, "identity", [3])).value).toBe(1);
      expect((await call(owner.port, "identity", [4 + 0o077 * 8])).value).toBe(0o022);
      expect(fixture.filesystem.posixPolicy?.umask).toBe(0o077);
      fixture.write("masked", "");
      expect(fixture.filesystem.getPosixMetadata("masked").mode & 0o777).toBe(0o600);
      await expect(call(owner.port, "identity", [5])).rejects.toThrow(
        "Unsupported BusyBox identity field",
      );
      expect(fixture.filesystem.posixPolicy?.umask).toBe(0o077);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("preserves cwd sizing, termination, errors and changed-byte-only responses", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect(await call(owner.port, "startup_cwd", [0, 0])).toEqual({ value: 10, regions: [] });
      expect(
        await call(
          owner.port,
          "startup_cwd",
          [64, 10],
          [{ pointer: 64, bytes: new Uint8Array(10) }],
        ),
      ).toEqual({ value: -68, regions: [] });
      const target = new Uint8Array(11).fill(0xff);
      const result = await call(
        owner.port,
        "startup_cwd",
        [64, 11],
        [{ pointer: 64, bytes: target }],
      );
      expect(result.value).toBe(10);
      expect(result.regions).toEqual([{ pointer: 64, bytes: text("/workspace\0") }]);
      expect(target).toEqual(new Uint8Array(11).fill(0xff));
      expect((await call(owner.port, "startup_cwd", [65_534, 11])).value).toBe(-21);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("keeps chmod, fchmod, descriptor metadata and chown permission checks on the borrowed filesystem", async () => {
    const fixture = childBusyboxFixture();
    fixture.write("owned", "data");
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const path = text("owned");
    const fd = fixture.filesystem.open("owned", KernelOpenFlags.O_RDWR);
    try {
      expect(
        await call(owner.port, "chmod", [32, path.length, 0o640], [{ pointer: 32, bytes: path }]),
      ).toEqual({ value: 0, regions: [] });
      expect(fixture.filesystem.getPosixMetadata("owned").mode & 0o777).toBe(0o640);
      expect((await call(owner.port, "fchmod", [fd, 0o600])).value).toBe(0);
      const metadata = await call(
        owner.port,
        "stat_metadata",
        [fd, 0, 0, 1, 64],
        [{ pointer: 64, bytes: new Uint8Array(12) }],
      );
      expect(viewAt(metadata.regions, 64, 12).getUint32(0, true)).toBe(0o100600);
      expect(
        (
          await call(
            owner.port,
            "chown",
            [-1, 32, path.length, -1, -1, 1],
            [{ pointer: 32, bytes: path }],
          )
        ).value,
      ).toBe(0);
      expect((await call(owner.port, "chown", [fd, 0, 0, 2000, -1, 1])).value).toBe(63);
      expect(fixture.filesystem.getPosixMetadata("owned").uid).toBe(1000);
      expect((await call(owner.port, "fchmod", [1, 0o777])).value).toBe(8);
    } finally {
      fixture.filesystem.close(fd);
      await owner.close();
      await fixture.close();
    }
  });

  it("preserves passwd/group record bytes, required sizing and ENOSPC", async () => {
    const fixture = childBusyboxFixture();
    fixture.write("/etc/passwd", "owner:x:1000:1000:Owner:/workspace:/bin/bash\n");
    fixture.write("/etc/group", "team:x:1000:owner,other\n");
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      const small = await call(
        owner.port,
        "account",
        [0, 0, 0, 0, 1000, 64, 0, 32],
        [{ pointer: 32, bytes: new Uint8Array(4) }],
      );
      const needed = viewAt(small.regions, 32, 4).getUint32(0, true);
      expect(small.value).toBe(68);
      const result = await call(
        owner.port,
        "account",
        [0, 1, 16, 5, 0, 64, needed, 32],
        [
          { pointer: 16, bytes: text("owner") },
          { pointer: 32, bytes: new Uint8Array(4) },
          { pointer: 64, bytes: new Uint8Array(needed).fill(0xff) },
        ],
      );
      expect(result.value).toBe(0);
      const view = viewAt(result.regions, 64, needed);
      expect([view.getUint32(0, true), view.getUint32(4, true)]).toEqual([1000, 1000]);
      expect(
        new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + 8, needed - 8)),
      ).toBe("owner\0x\0Owner\0/workspace\0/bin/bash\0");
      const group = await call(
        owner.port,
        "account",
        [1, 2, 0, 0, 0, 64, 64, 32],
        [
          { pointer: 32, bytes: new Uint8Array(4) },
          { pointer: 64, bytes: new Uint8Array(64).fill(0xff) },
        ],
      );
      expect(group.value).toBe(0);
      expect(viewAt(group.regions, 64, 8).getUint32(4, true)).toBe(2);
      expect(
        (
          await call(
            owner.port,
            "account",
            [0, 0, 0, 0, 999, 64, 64, 32],
            [{ pointer: 32, bytes: new Uint8Array(4) }],
          )
        ).value,
      ).toBe(44);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("requires a POSIX policy, matching effective IDs and a live process handle", async () => {
    const absent = childBusyboxFixture({ posix: false });
    const mismatch = childBusyboxFixture({
      posix: { credentials: { ...busyboxCredentials, euid: 0 }, umask: 0o022 },
    });
    try {
      expect(() => createKernelBusyboxHost({ context: absent.context })).toThrow(
        "explicit POSIX filesystem policy",
      );
      expect(() => createKernelBusyboxHost({ context: mismatch.context })).toThrow(
        "differing effective ids",
      );
      expect(() =>
        createKernelBusyboxHost({
          context: {
            ...mismatch.context,
            identity: { ...mismatch.context.identity, handle: { kind: "process", id: "absent" } },
          },
        }),
      ).toThrow("identity is unavailable");
    } finally {
      await absent.close();
      await mismatch.close();
    }
  });

  it("rejects malformed or unknown calls and leaves the port usable until close", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      await expect(call(owner.port, "execve", [])).rejects.toThrow("Unknown BusyBox syscall");
      await expect(call(owner.port, "toString", [])).rejects.toThrow("Unknown BusyBox syscall");
      await expect(
        call(owner.port, "identity", [0], [{ pointer: 65_536, bytes: new Uint8Array(1) }]),
      ).rejects.toThrow("Invalid syscall memory regions");
      expect((await call(owner.port, "identity", [0])).value).toBe(1000);
      await owner.close();
      await expect(call(owner.port, "identity", [0])).rejects.toThrow("unavailable");
      expect(fixture.filesystem.descriptors.has(1)).toBe(true);
      expect(fixture.context.processes.size).toBe(1);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("serializes WASI and Nimbus calls and waits for the active syscall on close", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<number>();
    const fixture = childBusyboxFixture({
      readInto: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const iovecs = new Uint8Array(8);
    new DataView(iovecs.buffer).setUint32(0, 128, true);
    new DataView(iovecs.buffer).setUint32(4, 1, true);
    const pending = owner.port.call({
      name: "fd_read",
      args: [0, 32, 1, 16],
      memorySize: 65_536,
      regions: [
        { pointer: 16, bytes: new Uint8Array(4) },
        { pointer: 32, bytes: iovecs },
        { pointer: 128, bytes: new Uint8Array(1) },
      ],
    });
    try {
      await entered.promise;
      await expect(call(owner.port, "identity", [0])).rejects.toThrow("already executing");
      const closing = owner.close();
      release.resolve(0);
      await pending;
      await closing;
      expect(fixture.filesystem.descriptors.has(0)).toBe(true);
    } finally {
      release.resolve(0);
      await pending;
      await owner.close();
      await fixture.close();
    }
  });
});
