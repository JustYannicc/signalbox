import { expect } from "vite-plus/test";
import { KernelOpenFlags, KernelFileSystem } from "../KernelFileSystem.ts";
import { createKernelSyscallHost } from "../KernelSyscallHost.ts";
import type { KernelSyscallRequest, KernelSyscallResponse } from "../KernelSyscallPort.ts";
import { createChildWasi } from "../../computer/ChildWasi.ts";
import { wasmImportCommand, wasmImportReactor } from "./wasmGuest.ts";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { sqliteFixture } from "./sqliteFixture.ts";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../KernelAbi.ts";
import { KernelProgramHost } from "../KernelProgramHost.ts";

export function createTestFilesystem() {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [
      {
        path: "/",
        storage: createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n),
      },
    ],
  });
  return {
    filesystem,
    close() {
      filesystem.dispose();
      fixture.close();
    },
  };
}
export const SIZE = 2 * 1024 * 1024;
const DATA = 1024;

export function guest(filesystem: KernelFileSystem, name: string, size = SIZE) {
  const controller = new AbortController();
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: controller.signal,
  });
  const positioned = name === "fd_pwrite";
  const module = wasmImportReactor(
    "wasi_snapshot_preview1",
    name,
    positioned ? ["i32", "i32", "i32", "i64", "i32"] : ["i32", "i32", "i32", "i32"],
    ["i32"],
  );
  let after: (
    request: KernelSyscallRequest,
    response: KernelSyscallResponse,
  ) => Promise<void> = async () => {};
  let entered: () => void = () => {};
  let calls = 0;
  const child = createChildWasi({
    module,
    args: [],
    env: {},
    syscalls: {
      async call(request) {
        entered();
        calls++;
        const response = await host.call(structuredClone(request));
        await after(request, response);
        return structuredClone(response);
      },
    },
  });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  const memory = instance.exports.memory as WebAssembly.Memory;
  memory.grow(Math.ceil(size / 65536));
  const view = new DataView(memory.buffer);
  view.setUint32(32, DATA, true);
  view.setUint32(36, size, true);
  return {
    controller,
    host,
    bytes: new Uint8Array(memory.buffer, DATA, size),
    view,
    get calls() {
      return calls;
    },
    after(fn: typeof after) {
      after = fn;
    },
    entered(fn: typeof entered) {
      entered = fn;
    },
    run: (fd: number, position = 0n) =>
      positioned
        ? child.run(instance.exports.run!, fd, 32, 1, position, 16)
        : child.run(instance.exports.run!, fd, 32, 1, 16),
    close() {
      host.close();
    },
  };
}

export function readFile(filesystem: KernelFileSystem, path: string, size: number) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  const bytes = new Uint8Array(size);
  try {
    expect(filesystem.read(fd, bytes, 0n)).toBe(size);
    return bytes;
  } finally {
    filesystem.close(fd);
  }
}

export function inline(filesystem: KernelFileSystem) {
  const hosts: KernelProgramHost[] = [];
  const data = new Uint8Array(128);
  const view = new DataView(data.buffer);
  view.setUint32(0, 64, true);
  view.setUint32(4, 6, true);
  data.set(new TextEncoder().encode("INLINE"), 64);
  const run = (name: string, params: readonly ("i32" | "i64")[], args: readonly number[]) => {
    const manifest = {
      name: "inline",
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "inline",
    };
    const registry = new KernelProgramRegistry();
    if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
    const host = new KernelProgramHost({
      registry,
      wakes: new KernelWakeRegistry(),
      programs: new Map([
        [
          "/bin/inline",
          {
            manifest,
            implementation: { kind: "wasm", module: wasmImportCommand(name, params, args, data) },
          },
        ],
      ]),
    });
    hosts.push(host);
    const resolved = host.resolve("/bin/inline");
    if (resolved.status !== "ok") throw new Error("Program resolution failed");
    return host.runInline(host.prepare({ filesystem }), resolved.value, [], {});
  };
  return {
    data,
    run,
    write: (fd: number) => run("fd_write", ["i32", "i32", "i32", "i32"], [fd, 0, 1, 16]),
    close: () =>
      Promise.all(
        hosts.map(async (host) => {
          await host.processes.dispose();
          host.wakes.dispose();
        }),
      ),
  };
}
