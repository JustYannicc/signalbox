import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { ABI_VERSION, KernelProgramRegistry } from "./KernelAbi.ts";
import { KernelProgramHost } from "./KernelProgramHost.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { WASI } from "./Wasi.ts";
import { wasmDeviceOpenCommand } from "./tests/wasiDeviceCommand.ts";
import {
  DATA,
  IOV,
  OUTPUT,
  PATH,
  PATH_OPEN,
  PATH_STAT,
  READ,
  STAT,
  WRITE,
  openDevice,
  wasiDeviceFixture,
} from "./tests/wasiDeviceFixture.ts";

describe("Kernel WASI virtual devices", () => {
  it("leaves unconfigured reusable WASI callers on their original inode-only behavior", async () => {
    const fixture = wasiDeviceFixture();
    const wasi = new WASI({
      version: "preview1",
      mounts: [{ path: "/", storage: fixture.storage }],
    });
    try {
      const instance = new WebAssembly.Instance(wasmDeviceOpenCommand(), wasi.getImportObject());
      expect(wasi.start(instance)).toBe(44);
      expect(fixture.storage.readdir(fixture.storage.root)).toEqual([]);
    } finally {
      wasi.close();
      await fixture.close();
    }
  });

  it("opens a device in a real WASM command through the public program host", async () => {
    const fixture = wasiDeviceFixture();
    const wakes = new KernelWakeRegistry();
    const registry = new KernelProgramRegistry();
    const manifest = {
      name: "device-open",
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "device-open-v1",
    };
    expect(registry.register(manifest).status).toBe("ok");
    const host = new KernelProgramHost({
      registry,
      wakes,
      programs: new Map([
        [
          "/bin/device-open",
          { manifest, implementation: { kind: "wasm", module: wasmDeviceOpenCommand() } },
        ],
      ]),
    });
    try {
      const resolved = host.resolve("/bin/device-open");
      if (resolved.status !== "ok") throw new Error("Could not resolve device command");
      const prepared = host.prepare({ filesystem: fixture.filesystem });
      const table = prepared.filesystem.descriptors;
      expect(host.runInline(prepared, resolved.value, [], {})).toBe(0);
      expect([...table.entries()]).toEqual([]);
      expect(fixture.storage.readdir(fixture.storage.root)).toEqual([]);
    } finally {
      await host.processes.dispose();
      wakes.dispose();
      await fixture.close();
    }
  });
  it.each(["null", "zero", "random"])(
    "shares canonical %s identity and I/O without storage nodes",
    async (name) => {
      const fixture = wasiDeviceFixture();
      const { filesystem, storage } = fixture;
      try {
        const before = [...filesystem.descriptors.entries()].length;
        const open = await fixture.syscall("path_open");
        expect(await openDevice(open, `dev/${name}`)).toBe(0);
        const fd = open.view().getUint32(OUTPUT, true);
        const canonical = filesystem.open(`/dev/${name}`, KernelOpenFlags.O_RDWR);
        expect(filesystem.descriptors.get(fd).stdio).toBe(
          filesystem.descriptors.get(canonical).stdio,
        );
        expect(filesystem.fstat(fd)).toEqual(filesystem.stat(`/dev/${name}`));
        const read = await fixture.syscall("fd_read");
        read.iovec(new Uint8Array(8).fill(123));
        expect(await read.run(fd, IOV, 1, OUTPUT)).toBe(0);
        expect(read.view().getUint32(OUTPUT, true)).toBe(name === "null" ? 0 : 8);
        if (name === "zero")
          expect([...new Uint8Array(read.memory.buffer, DATA, 8)]).toEqual(Array(8).fill(0));
        const write = await fixture.syscall("fd_write");
        write.iovec(new TextEncoder().encode("discard me"));
        expect(await write.run(fd, IOV, 1, OUTPUT)).toBe(0);
        expect(write.view().getUint32(OUTPUT, true)).toBe(10);
        expect(filesystem.fstat(fd).size).toBe(0n);
        const stat = await fixture.syscall("fd_filestat_get");
        expect(await stat.run(fd, 65_535)).toBe(21);
        expect(await stat.run(fd, OUTPUT)).toBe(0);
        expect(stat.view().getBigUint64(OUTPUT, true)).toBe(0n);
        expect(stat.view().getBigUint64(OUTPUT + 8, true)).toBe(filesystem.fstat(canonical).ino);
        expect(stat.view().getUint8(OUTPUT + 16)).toBe(2);
        const pathStat = await fixture.syscall("path_filestat_get");
        expect(await pathStat.run(3, 2, PATH, pathStat.path(`dev/${name}`), OUTPUT)).toBe(28);
        expect(await pathStat.run(3, 0, PATH, pathStat.path(`dev/${name}`), OUTPUT)).toBe(0);
        expect(new Uint8Array(pathStat.memory.buffer, OUTPUT, 64)).toEqual(
          new Uint8Array(stat.memory.buffer, OUTPUT, 64),
        );
        const close = await fixture.syscall("fd_close");
        const alias = filesystem.descriptors.duplicate(fd);
        expect(await close.run(fd)).toBe(0);
        expect(filesystem.descriptors.has(fd)).toBe(false);
        expect(await write.run(alias, IOV, 1, OUTPUT)).toBe(0);
        expect(await close.run(alias)).toBe(0);
        expect(await close.run(fd)).toBe(8);
        filesystem.close(canonical);
        expect([...filesystem.descriptors.entries()].length).toBe(before);
        expect(storage.readdir(storage.root)).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("resolves relative dirfds, moved preopens and the AgentOS hidden tag", async () => {
    const fixture = wasiDeviceFixture();
    const { filesystem } = fixture;
    try {
      filesystem.mkdir("/dev");
      const directory = filesystem.open(
        "/dev",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, "./null", READ, { fd: directory })).toBe(0);
      filesystem.close(open.view().getUint32(OUTPUT, true));
      const moved = filesystem.descriptors.duplicate(3);
      filesystem.close(3);
      const tagged = await fixture.syscall("path_open", true);
      expect(await openDevice(tagged, "dev/null", READ, { fd: moved | 0x4000_0000 })).toBe(0);
      filesystem.close(tagged.view().getUint32(OUTPUT, true));
      expect(await openDevice(open, "dev/null", READ, { fd: 3 })).toBe(8);
      expect(await openDevice(open, "../dev/null", READ, { fd: directory })).toBe(0);
      filesystem.close(open.view().getUint32(OUTPUT, true));
      filesystem.rename("/dev", "/elsewhere");
      expect(await openDevice(open, "null", READ, { fd: directory })).toBe(44);
    } finally {
      await fixture.close();
    }
  });

  it("follows stored symlinks and keeps stored shadowing nodes authoritative", async () => {
    const fixture = wasiDeviceFixture();
    const { filesystem, storage } = fixture;
    try {
      filesystem.symlink("/dev/null", "/alias");
      filesystem.symlink("/dev", "/device-directory");
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, "alias", READ, { dirflags: 0 })).toBe(32);
      expect(await openDevice(open, "alias", READ, { dirflags: 1 })).toBe(0);
      filesystem.close(open.view().getUint32(OUTPUT, true));
      expect(await openDevice(open, "device-directory/null", READ)).toBe(0);
      filesystem.close(open.view().getUint32(OUTPUT, true));
      filesystem.mkdir("/dev");
      // KernelFS reserves exact device opens; seed a stored shadow through its canonical storage.
      const dev = storage.lookup(storage.root, "dev");
      const inode = storage.create(dev, "null", { type: "file", exclusive: true });
      storage.release(inode);
      expect(await openDevice(open, "dev/null", READ)).toBe(0);
      const fd = open.view().getUint32(OUTPUT, true);
      expect(filesystem.descriptors.get(fd).kind).toBe("file");
      filesystem.close(fd);
      filesystem.unlink("/alias");
      filesystem.symlink("/elsewhere", "/alias");
      expect(await openDevice(open, "alias/null", READ, { dirflags: 1 })).toBe(44);
    } finally {
      await fixture.close();
    }
  });

  it("attenuates rights and rejects capability expansion before dispatch", async () => {
    const fixture = wasiDeviceFixture();
    const { filesystem } = fixture;
    try {
      const open = await fixture.syscall("path_open");
      const read = await fixture.syscall("fd_read");
      const write = await fixture.syscall("fd_write");
      read.iovec(new Uint8Array(1));
      write.iovec(new Uint8Array([42]));
      for (const rights of [READ, WRITE, 0n]) {
        expect(await openDevice(open, "dev/null", rights)).toBe(0);
        const fd = open.view().getUint32(OUTPUT, true);
        const fdstat = await fixture.syscall("fd_fdstat_get");
        expect(await fdstat.run(fd, OUTPUT)).toBe(0);
        expect(fdstat.view().getBigUint64(OUTPUT + 8, true)).toBe(rights);
        expect(fdstat.view().getBigUint64(OUTPUT + 16, true)).toBe(0n);
        expect(await read.run(fd, IOV, 1, OUTPUT)).toBe(rights === READ ? 0 : 76);
        expect(await write.run(fd, IOV, 1, OUTPUT)).toBe(rights === WRITE ? 0 : 76);
        const stat = await fixture.syscall("fd_filestat_get");
        expect(await stat.run(fd, OUTPUT)).toBe(76);
        filesystem.close(fd);
      }
      const root = filesystem.descriptors.get(3);
      const before = [...filesystem.descriptors.entries()].length;
      root.rightsInheriting = READ;
      expect(await openDevice(open, "dev/null", WRITE)).toBe(76);
      expect(await openDevice(open, "dev/null", READ, { inheriting: WRITE })).toBe(76);
      root.rightsBase &= ~PATH_OPEN;
      expect(await openDevice(open, "dev/null", READ)).toBe(76);
      root.rightsBase &= ~PATH_STAT;
      const stat = await fixture.syscall("path_filestat_get");
      expect(await stat.run(3, 0, PATH, stat.path("dev/null"), OUTPUT)).toBe(76);
      expect([...filesystem.descriptors.entries()].length).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  it("does not replace a stored /dev symlink or file, or add devices to another mount", async () => {
    const fixture = wasiDeviceFixture();
    try {
      const { filesystem, storage } = fixture;
      filesystem.mkdir("/elsewhere");
      filesystem.symlink("/elsewhere", "/dev");
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, "dev/null", READ, { dirflags: 1 })).toBe(44);
      filesystem.unlink("/dev");
      const inode = storage.create(storage.root, "dev", { type: "file", exclusive: true });
      storage.release(inode);
      expect(await openDevice(open, "dev/null", READ)).toBe(54);
    } finally {
      await fixture.close();
    }
    const confined = wasiDeviceFixture({ mountPath: "/work" });
    try {
      const open = await confined.syscall("path_open");
      expect(await openDevice(open, "dev/null", READ)).toBe(44);
      expect(await openDevice(open, "../dev/null", READ)).toBe(76);
    } finally {
      await confined.close();
    }
  });

  it("rejects invalid flags, pointers, paths and fds without allocating or mutating", async () => {
    const fixture = wasiDeviceFixture();
    const { filesystem, storage } = fixture;
    try {
      const open = await fixture.syscall("path_open");
      const before = [...filesystem.descriptors.entries()].length;
      expect(await openDevice(open, "dev/null", READ, { fd: 999 })).toBe(8);
      expect(await openDevice(open, "dev/null", READ, { dirflags: 2 })).toBe(28);
      expect(await openDevice(open, "dev/null", READ, { oflags: 16 })).toBe(28);
      expect(await openDevice(open, "dev/null", READ, { fdflags: 32 })).toBe(28);
      expect(await openDevice(open, "dev/null", READ, { fdflags: 4 })).toBe(58);
      expect(await openDevice(open, "dev/null", 1n << 63n)).toBe(76);
      expect(await openDevice(open, "dev/null", READ, { oflags: 2 })).toBe(54);
      expect(await openDevice(open, "dev/null/", READ)).toBe(54);
      expect(await openDevice(open, "dev/null/.", READ)).toBe(54);
      expect(await openDevice(open, "dev/null/../other", READ)).toBe(54);
      expect(await openDevice(open, "dev/null", READ, { oflags: 5 })).toBe(20);
      expect(await openDevice(open, "dev/null", READ, { oflags: 3 })).toBe(28);
      expect(await openDevice(open, "dev/null", READ, { output: 65_535 })).toBe(21);
      expect(await open.run(3, 0, 65_535, 8, 0, READ, 0n, 0, OUTPUT)).toBe(21);
      expect(await openDevice(open, new Uint8Array([255]), READ)).toBe(25);
      expect(await openDevice(open, "dev/null\0", READ)).toBe(28);
      expect(await openDevice(open, "", READ)).toBe(44);
      expect(await openDevice(open, "/dev/null", READ)).toBe(76);
      expect(await openDevice(open, "../dev/null", READ)).toBe(76);
      expect(await openDevice(open, "dev/unknown", READ)).toBe(44);
      expect(await openDevice(open, "dev/null", WRITE, { oflags: 9 })).toBe(0);
      filesystem.close(open.view().getUint32(OUTPUT, true));
      expect([...filesystem.descriptors.entries()].length).toBe(before);
      expect(storage.readdir(storage.root)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("preserves read-only mount policy and direct /dev preopen reach", async () => {
    const fixture = wasiDeviceFixture({ readOnly: true, deviceMount: true });
    try {
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, "null", READ | STAT)).toBe(0);
      fixture.filesystem.close(open.view().getUint32(OUTPUT, true));
      expect(await openDevice(open, "null", WRITE)).toBe(76);
      expect(await openDevice(open, "null", READ, { oflags: 8 })).toBe(76);
      expect(await openDevice(open, "../dev/null", READ)).toBe(76);
      expect(fixture.storage.readdir(fixture.storage.root)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a root capability crossing /dev while serving the mount's own preopen", async () => {
    const fixture = wasiDeviceFixture({ overlay: true });
    try {
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, "dev/null", READ)).toBe(76);
      expect(await openDevice(open, "null", READ, { fd: 4 })).toBe(0);
      fixture.filesystem.close(open.view().getUint32(OUTPUT, true));
    } finally {
      await fixture.close();
    }
  });
});
