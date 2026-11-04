import { expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { reopenInheritedFds } from "./KernelInheritedFds.ts";
import {
  DATA,
  IOV,
  OUTPUT,
  PATH,
  READ,
  STAT,
  openDevice,
  wasiDeviceFixture,
} from "./tests/wasiDeviceFixture.ts";

it.each(["/dev/fd/3", "/proc/self/fd/3"])(
  "keeps WASI preopens and opens the inherited POSIX alias %s",
  async (path) => {
    const fixture = wasiDeviceFixture();
    const fs = fixture.filesystem;
    try {
      const writer = fs.open("/target", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      fs.write(writer, new TextEncoder().encode("before:needle"), null);
      fs.close(writer);
      reopenInheritedFds(fs, [{ childFd: 3, path: "/target", flags: 0, offset: 0 }]);
      const prestat = await fixture.syscall("fd_prestat_get");
      expect(await prestat.run(3, OUTPUT)).toBe(0);
      expect(await prestat.run(4, OUTPUT)).toBe(8);
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, path.slice(1), READ | STAT, { dirflags: 1 })).toBe(0);
      const opened = open.view().getUint32(OUTPUT, true);
      expect(await openDevice(open, "dev/stdin", READ)).toBe(44);
      const read = await fixture.syscall("fd_read");
      read.iovec(new Uint8Array(13));
      expect(await read.run(opened, IOV, 1, OUTPUT)).toBe(0);
      expect(new TextDecoder().decode(new Uint8Array(read.memory.buffer, DATA, 13))).toBe(
        "before:needle",
      );
      read.iovec(new Uint8Array(13));
      expect(await read.run(4, IOV, 1, OUTPUT)).toBe(0);
      expect(new TextDecoder().decode(new Uint8Array(read.memory.buffer, DATA, 13))).toBe(
        "before:needle",
      );
      const stat = await fixture.syscall("path_filestat_get");
      expect(await stat.run(3, 1, PATH, stat.path(path.slice(1)), OUTPUT)).toBe(0);
      expect(stat.view().getUint8(OUTPUT + 16)).toBe(4);
      expect(fs.readlink(path)).toBe("/target");
    } finally {
      await fixture.close();
    }
  },
);

it("clears the inherited POSIX alias when a program renumbers onto it", async () => {
  const fixture = wasiDeviceFixture();
  const fs = fixture.filesystem;
  try {
    for (const path of ["/original", "/replacement"]) {
      const fd = fs.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      fs.write(fd, new TextEncoder().encode(path), null);
      fs.close(fd);
    }
    reopenInheritedFds(fs, [{ childFd: 3, path: "/original", flags: 0, offset: 0 }]);
    const renumber = await fixture.syscall("fd_renumber");
    const replacement = fs.open("/replacement", KernelOpenFlags.O_RDONLY);
    expect(await renumber.run(replacement, 3)).toBe(0);
    const fd = fs.open("/dev/fd/3", KernelOpenFlags.O_RDONLY);
    const output = new Uint8Array(12);
    expect(fs.read(fd, output, null)).toBe(12);
    expect(new TextDecoder().decode(output)).toBe("/replacement");
    fs.close(fd);
  } finally {
    await fixture.close();
  }
});
