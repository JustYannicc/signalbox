import { describe, expect, it } from "vite-plus/test";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { KernelBusyboxCall, KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createChildBusyboxImports } from "../ChildBusyboxImports.ts";
import { childBusyboxFixture, text } from "./ChildBusyboxFixture.ts";

// A real WASM caller is required for JSPI suspension; a direct JS call cannot exercise it.
function importReactor(namespace: string, name: string, count: number) {
  const encoded = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const body = [0, ...Array.from({ length: count }, (_, index) => [32, index]).flat(), 16, 0, 11];
  return new WebAssembly.Module(
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
      ...section(2, [1, ...encoded(namespace), ...encoded(name), 0, 0]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...encoded("memory"), 2, 0, ...encoded("run"), 0, 1]),
      ...section(10, [1, body.length, ...body]),
    ]),
  );
}

function bridge(port: KernelBusyboxPort, name: string, count: number) {
  const module = importReactor("nimbus_proc", name, count);
  const imports = createChildBusyboxImports({ module, port });
  const instance = new WebAssembly.Instance(module, imports.imports);
  imports.bind(instance);
  const wasm = WebAssembly as unknown as {
    promising(fn: (...args: number[]) => number): (...args: number[]) => Promise<number>;
  };
  return {
    memory: instance.exports.memory as WebAssembly.Memory,
    run: wasm.promising(instance.exports.run as (...args: number[]) => number),
  };
}

describe("Nimbus BusyBox child import ranges", () => {
  it("sends only the stat path and 12-byte output, preserving unrelated guest bytes", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const requests: KernelBusyboxCall[] = [];
    const port: KernelBusyboxPort = {
      ...owner.port,
      async callBusybox(request) {
        requests.push(request);
        return structuredClone(await owner.port.callBusybox(structuredClone(request)));
      },
    };
    try {
      const guest = bridge(port, "stat_metadata", 5);
      const heap = new Uint8Array(guest.memory.buffer).fill(0xa5);
      heap.set(text("nested"), 32);
      expect(await guest.run(-1, 32, 6, 1, 64)).toBe(0);
      expect(requests[0]!.regions.map(({ pointer, bytes }) => [pointer, bytes.length])).toEqual([
        [32, 6],
        [64, 12],
      ]);
      expect(new DataView(guest.memory.buffer).getUint32(64, true)).toBe(0o040755);
      expect(heap.subarray(76)).toEqual(new Uint8Array(heap.length - 76).fill(0xa5));
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("copies the account lookup name, output capacity and needed word with the Nimbus record ABI", async () => {
    const fixture = childBusyboxFixture();
    fixture.write("/etc/passwd", "owner:x:1000:1000:Owner:/workspace:/bin/bash\n");
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const requests: KernelBusyboxCall[] = [];
    const port: KernelBusyboxPort = {
      ...owner.port,
      async callBusybox(request) {
        requests.push(request);
        return structuredClone(await owner.port.callBusybox(structuredClone(request)));
      },
    };
    try {
      const guest = bridge(port, "account", 8);
      const heap = new Uint8Array(guest.memory.buffer).fill(0xa5);
      heap.set(text("owner"), 16);
      expect(await guest.run(0, 1, 16, 5, 0, 64, 64, 32)).toBe(0);
      expect(requests[0]!.regions.map(({ pointer, bytes }) => [pointer, bytes.length])).toEqual([
        [16, 5],
        [32, 4],
        [64, 64],
      ]);
      const view = new DataView(guest.memory.buffer);
      expect([view.getUint32(64, true), view.getUint32(68, true)]).toEqual([1000, 1000]);
      expect(new TextDecoder().decode(heap.subarray(72, 64 + view.getUint32(32, true)))).toBe(
        "owner\0x\0Owner\0/workspace\0/bin/bash\0",
      );
      expect(heap[128]).toBe(0xa5);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("uses path bytes for chmod and chown while fchmod uses the original descriptor", async () => {
    const fixture = childBusyboxFixture();
    fixture.write("owned", "data");
    const fd = fixture.filesystem.open("owned", KernelOpenFlags.O_RDWR);
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const requests: KernelBusyboxCall[] = [];
    const port: KernelBusyboxPort = {
      ...owner.port,
      async callBusybox(request) {
        requests.push(request);
        return owner.port.callBusybox(structuredClone(request));
      },
    };
    try {
      const chmod = bridge(port, "chmod", 3);
      new Uint8Array(chmod.memory.buffer, 16, 5).set(text("owned"));
      expect(await chmod.run(16, 5, 0o600)).toBe(0);
      expect(fixture.filesystem.getPosixMetadata("owned").mode & 0o777).toBe(0o600);
      const fchmod = bridge(port, "fchmod", 2);
      expect(await fchmod.run(fd, 0o640)).toBe(0);
      const chown = bridge(port, "chown", 6);
      new Uint8Array(chown.memory.buffer, 16, 5).set(text("owned"));
      expect(await chown.run(-1, 16, 5, -1, -1, 1)).toBe(0);
      expect(await chown.run(fd, 0, 0, -1, -1, 1)).toBe(0);
      expect(
        requests.map(({ regions }) => regions.map(({ pointer, bytes }) => [pointer, bytes.length])),
      ).toEqual([[[16, 5]], [], [[16, 5]], []]);
      expect(fixture.filesystem.getPosixMetadata("owned").mode & 0o777).toBe(0o640);
    } finally {
      fixture.filesystem.close(fd);
      await owner.close();
      await fixture.close();
    }
  });

  it("keeps identity memory-free and bounds startup cwd to its declared capacity", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const requests: KernelBusyboxCall[] = [];
    const port: KernelBusyboxPort = {
      ...owner.port,
      async callBusybox(request) {
        requests.push(request);
        return owner.port.callBusybox(request);
      },
    };
    try {
      const identity = bridge(port, "identity", 1);
      expect(await identity.run(2)).toBe(fixture.context.identity.pid);
      expect(await identity.run(4 + 0o027 * 8)).toBe(0o022);
      expect(fixture.filesystem.posixPolicy?.umask).toBe(0o027);
      const cwd = bridge(port, "startup_cwd", 2);
      expect(await cwd.run(0, 0)).toBe(10);
      expect(await cwd.run(32, 11)).toBe(10);
      expect(new Uint8Array(cwd.memory.buffer, 32, 11)).toEqual(text("/workspace\0"));
      expect(
        requests.map(({ regions }) => regions.map(({ pointer, bytes }) => [pointer, bytes.length])),
      ).toEqual([[], [], [], [[32, 11]]]);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("rejects an owner response outside the ABI ranges before touching unrelated memory", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const port: KernelBusyboxPort = {
      ...owner.port,
      async callBusybox() {
        return { value: 0, regions: [{ pointer: 1024, bytes: new Uint8Array([99]) }] };
      },
    };
    try {
      const guest = bridge(port, "startup_cwd", 2);
      await expect(guest.run(32, 11)).rejects.toThrow("Invalid syscall memory response regions");
      expect(new Uint8Array(guest.memory.buffer)[1024]).toBe(0);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("rejects generic AgentOS and unknown Nimbus imports instead of choosing another ABI", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect(() =>
        createChildBusyboxImports({
          module: importReactor("host_process", "proc_getpid", 1),
          port: owner.port,
        }),
      ).toThrow("Unsupported BusyBox import: host_process.proc_getpid");
      expect(() =>
        createChildBusyboxImports({
          module: importReactor("nimbus_proc", "toString", 1),
          port: owner.port,
        }),
      ).toThrow("Unsupported BusyBox import: nimbus_proc.toString");
    } finally {
      await owner.close();
      await fixture.close();
    }
  });
});
