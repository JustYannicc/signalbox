import { describe, expect, it, vi } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { AgentOsDescriptorHost } from "../../kernel/AgentOsDescriptorHost.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { childBusyboxFixture, text } from "./ChildBusyboxFixture.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

const decoder = new TextDecoder();
type Fixture = ReturnType<typeof childBusyboxFixture>;

function guest(fixture: Fixture, sigpipe?: "epipe") {
  const host = createKernelSyscallHost({
    ...fixture.context,
    ...(sigpipe === undefined ? {} : { sigpipe }),
  });
  function reactor(name: string, params: readonly ("i32" | "i64")[]) {
    const module = wasmImportReactor("wasi_snapshot_preview1", name, params, ["i32"]);
    const wasi = createChildWasi({ module, syscalls: host, args: [], env: {} });
    const instance = new WebAssembly.Instance(module, wasi.imports);
    wasi.bind(instance);
    const memory = instance.exports.memory as WebAssembly.Memory;
    return { wasi, instance, memory, view: new DataView(memory.buffer) };
  }
  async function io(name: "fd_read" | "fd_write", fd: number, bytes: Uint8Array) {
    const r = reactor(name, ["i32", "i32", "i32", "i32"]);
    r.view.setUint32(32, 128, true);
    r.view.setUint32(36, bytes.length, true);
    new Uint8Array(r.memory.buffer, 128, bytes.length).set(bytes);
    const errno = await r.wasi.run(r.instance.exports.run!, fd, 32, 1, 16);
    const count = r.view.getUint32(16, true);
    return { errno, count, bytes: new Uint8Array(r.memory.buffer, 128, count).slice() };
  }
  return {
    read: (fd: number, size: number) => io("fd_read", fd, new Uint8Array(size)),
    write: (fd: number, value: string) => io("fd_write", fd, text(value)),
    async seek(fd: number, position: bigint) {
      const r = reactor("fd_seek", ["i32", "i64", "i32", "i32"]);
      const errno = await r.wasi.run(r.instance.exports.run!, fd, position, 0, 64);
      return { errno, position: Number(r.view.getBigUint64(64, true)) };
    },
    async sync(fd: number) {
      const r = reactor("fd_sync", ["i32"]);
      return r.wasi.run(r.instance.exports.run!, fd);
    },
    async fdstat(fd: number) {
      const r = reactor("fd_fdstat_get", ["i32", "i32"]);
      expect(await r.wasi.run(r.instance.exports.run!, fd, 64)).toBe(0);
      return { flags: r.view.getUint16(66, true), filetype: r.view.getUint8(64) };
    },
    close: () => host.close(),
  };
}

describe("child I/O visibility and ordering", () => {
  it("observes another writer between reads", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    fixture.write("input", "abcdefgh");
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_RDONLY);
    const writer = fixture.filesystem.open("input", KernelOpenFlags.O_WRONLY);
    try {
      expect(decoder.decode((await child.read(fd, 2)).bytes)).toBe("ab");
      fixture.filesystem.write(writer, text("XX"), 2n);
      const current = decoder.decode((await child.read(fd, 2)).bytes);
      expect(current).toBe("XX");
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("advances a shared open description only by the bytes the guest consumed", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    fixture.write("input", "abcdefgh");
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_RDONLY);
    const alias = fixture.filesystem.descriptors.duplicate(fd);
    try {
      await child.read(fd, 2);
      const current = decoder.decode((await child.read(alias, 2)).bytes);
      expect(current).toBe("cd");
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("publishes successful writes to another reader before sync or exit", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    fixture.write("input", "old");
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC);
    try {
      const result = await child.write(fd, "new");
      expect(result.errno).toBe(0);
      const afterReturn = fixture.read("input");
      expect(afterReturn).toBe("new");
      expect(await child.sync(fd)).toBe(0);
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("preserves completed O_APPEND writes relative to an external appender", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    fixture.write("input", "");
    const fd = fixture.filesystem.open(
      "input",
      KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
    );
    const other = fixture.filesystem.open(
      "input",
      KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
    );
    try {
      await child.write(fd, "A");
      fixture.filesystem.write(other, text("B"), null);
      const current = fixture.read("input");
      expect(current).toBe("AB");
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("orders writes and lseek on the same open description", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    fixture.write("input", "");
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_WRONLY);
    try {
      await child.write(fd, "A");
      expect(await child.seek(fd, 0n)).toEqual({ errno: 0, position: 0 });
      await child.write(fd, "B");
      const current = fixture.read("input");
      expect(current).toBe("B");
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("reports ESPIPE when a guest probes a stream's seekability", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    try {
      expect(await child.seek(0, 0n)).toEqual({ errno: 70, position: 0 });
      expect(await child.seek(1, 0n)).toEqual({ errno: 70, position: 0 });
      expect(await child.seek(99999, 0n)).toEqual({ errno: 8, position: 0 });
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("identifies a real pipe as a nonterminal before Bash reads a record", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new AgentOsDescriptorHost({
      memory: () => memory,
      descriptors: fixture.filesystem.descriptors,
      wakes: fixture.context.wakes,
      asyncMode: true,
    });
    try {
      expect(descriptors.imports.fd_pipe(0, 4)).toBe(0);
      const readFd = new DataView(memory.buffer).getUint32(0, true);
      expect((await child.fdstat(readFd)).filetype).toBe(0);
      expect(await child.seek(readFd, 0n)).toEqual({ errno: 70, position: 0 });
    } finally {
      child.close();
      await fixture.close();
    }
  });

  it("orders stdout and stderr operations in one process", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    const order: string[] = [];
    const stdout = vi
      .spyOn(fixture.filesystem.descriptors.get(1).stdio!, "write")
      .mockImplementation((bytes) => {
        order.push(decoder.decode(bytes));
        return bytes.length;
      });
    const stderr = vi
      .spyOn(fixture.filesystem.descriptors.get(2).stdio!, "write")
      .mockImplementation((bytes) => {
        order.push(decoder.decode(bytes));
        return bytes.length;
      });
    try {
      await child.write(1, "A");
      await child.write(2, "X");
      await child.write(1, "B");
      const current = order.join("");
      expect(current).toBe("AXB");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      child.close();
      await fixture.close();
    }
  });

  it("keeps backpressure when a pipe has exhausted its 64 KiB capacity", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    const pipe = new KernelPipe(fixture.context.wakes);
    const entered = Promise.withResolvers<void>();
    let settled = false;
    const spy = vi
      .spyOn(fixture.filesystem.descriptors.get(1).stdio!, "write")
      .mockImplementation((bytes) => {
        entered.resolve();
        return pipe.writeBlocking(bytes);
      });
    try {
      expect(await pipe.write(new Uint8Array(65_536))).toBe(65_536);
      const pending = child.write(1, "A").then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      expect(settled).toBe(false);
      expect(pipe.bufferedBytes).toBe(65_536);
      const read = pipe.tryReadInto(new Uint8Array(4096));
      expect(read).toBe(4096);
      const result = await pending;
      expect(result.count).toBe(1);
    } finally {
      pipe.closeReader();
      pipe.closeWriter();
      spy.mockRestore();
      child.close();
      await fixture.close();
    }
  });

  it.each([undefined, "epipe"] as const)(
    "reports closed pipe with %s disposition",
    async (sigpipe) => {
      const fixture = childBusyboxFixture();
      const child = guest(fixture, sigpipe);
      const pipe = new KernelPipe(fixture.context.wakes);
      const spy = vi
        .spyOn(fixture.filesystem.descriptors.get(1).stdio!, "write")
        .mockImplementation((bytes) => pipe.writeBlocking(bytes));
      pipe.closeReader();
      try {
        if (sigpipe === "epipe") {
          const result = await child.write(1, "A");
          expect(result.errno).toBe(64);
        } else {
          await expect(child.write(1, "A")).rejects.toMatchObject({ signal: 13 });
        }
      } finally {
        pipe.closeWriter();
        spy.mockRestore();
        child.close();
        await fixture.close();
      }
    },
  );

  it("observes a shared descriptor flag mutation instead of caching fd_fdstat_get", async () => {
    const fixture = childBusyboxFixture();
    const child = guest(fixture);
    fixture.write("input", "");
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_WRONLY);
    const alias = fixture.filesystem.descriptors.duplicate(fd);
    try {
      const before = await child.fdstat(fd);
      fixture.filesystem.descriptors.get(alias).flags |= 1;
      const after = await child.fdstat(fd);
      expect(before.flags & 1).toBe(0);
      expect(after.flags & 1).toBe(1);
    } finally {
      child.close();
      await fixture.close();
    }
  });
});
