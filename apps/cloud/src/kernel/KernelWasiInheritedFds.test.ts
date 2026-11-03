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
      reopenInheritedFds(fs, [{ childFd: 3, path: "/target", flags: 0, offset: 7 }]);
      const prestat = await fixture.syscall("fd_prestat_get");
      expect(await prestat.run(3, OUTPUT)).toBe(0);
      expect(await prestat.run(4, OUTPUT)).toBe(8);
      const open = await fixture.syscall("path_open");
      expect(await openDevice(open, path.slice(1), READ | STAT, { dirflags: 1 })).toBe(0);
      const opened = open.view().getUint32(OUTPUT, true);
      const read = await fixture.syscall("fd_read");
      read.iovec(new Uint8Array(13));
      expect(await read.run(opened, IOV, 1, OUTPUT)).toBe(0);
      expect(new TextDecoder().decode(new Uint8Array(read.memory.buffer, DATA, 13))).toBe(
        "before:needle",
      );
      expect(fs.descriptors.getPosix(3).offset).toBe(7n);
      const stat = await fixture.syscall("path_filestat_get");
      expect(await stat.run(3, 1, PATH, stat.path(path.slice(1)), OUTPUT)).toBe(0);
      expect(stat.view().getUint8(OUTPUT + 16)).toBe(4);
      expect(fs.readlink(path)).toBe("/target");
    } finally {
      await fixture.close();
    }
  },
);
