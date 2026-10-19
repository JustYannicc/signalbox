import { describe, expect, it } from "vite-plus/test";
import { createKernelCoreutilsImports } from "../../kernel/KernelCoreutilsImports.ts";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createChildCoreutilsImports } from "../ChildCoreutilsImports.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

describe("Coreutils child host", () => {
  it("exposes admitted identity and file ownership through imports", async () => {
    const credentials = { uid: 1201, gid: 1302, euid: 1201, egid: 1504 };
    const fixture = childBusyboxFixture({
      posix: { credentials, umask: 0o022 },
    });
    const owner = createKernelCoreutilsHost({ context: fixture.context });
    let fd: number | undefined;
    try {
      fixture.write("owned.txt", "owned");
      fd = fixture.filesystem.open("owned.txt", KernelOpenFlags.O_RDONLY);

      for (const [name, expected] of [
        ["getuid", credentials.uid],
        ["getgid", credentials.gid],
        ["geteuid", credentials.euid],
        ["getegid", credentials.egid],
      ] as const) {
        const identity = childImport(owner.port, "host_user", name, ["i32"], ["i32"]);
        expect(await identity.run(16)).toBe(0);
        expect(readGuestU32(identity.memory, 16)).toBe(expected);
      }

      const ownership = childImport(
        owner.port,
        "host_fs",
        "fd_owner",
        ["i32", "i32", "i32"],
        ["i32"],
      );
      expect(await ownership.run(fd, 24, 28)).toBe(0);
      expect([readGuestU32(ownership.memory, 24), readGuestU32(ownership.memory, 28)]).toEqual([
        credentials.euid,
        credentials.egid,
      ]);
      expect(fixture.filesystem.cwd).toBe("/workspace");
    } finally {
      if (fd !== undefined) fixture.filesystem.close(fd);
      await owner.close();
      await fixture.close();
    }
  });

  it("requires an admitted POSIX identity for the child host", async () => {
    const fixture = childBusyboxFixture({ posix: false });
    try {
      expect(() => createKernelCoreutilsHost({ context: fixture.context })).toThrow(
        "Coreutils requires the admitted filesystem POSIX identity",
      );
    } finally {
      await fixture.close();
    }
  });

  it("keeps direct imports without credentials at ENOSYS", async () => {
    const fixture = childBusyboxFixture();
    const module = wasmImportReactor("host_user", "getuid", ["i32"], ["i32"]);
    let memory: WebAssembly.Memory | undefined;
    try {
      const imports = createKernelCoreutilsImports({
        module,
        memory: () => {
          if (memory === undefined) throw new Error("Guest memory is not bound");
          return memory;
        },
        fileSystem: fixture.filesystem,
        wakes: fixture.context.wakes,
        asyncMode: false,
      });
      const instance = new WebAssembly.Instance(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      const run = instance.exports.run as (pointer: number) => number;

      expect(run(64)).toBe(52);
    } finally {
      await fixture.close();
    }
  });

  it("checks descriptor output pointers before duplicating a descriptor", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelCoreutilsHost({ context: fixture.context });
    fixture.write("duplicate.txt", "data");
    const fd = fixture.filesystem.open("duplicate.txt", KernelOpenFlags.O_RDONLY);
    try {
      const before = Array.from(fixture.filesystem.descriptors.entries()).length;
      const module = wasmImportReactor("host_process", "fd_dup", ["i32", "i32"], ["i32"]);
      const imports = createChildCoreutilsImports({ module, port: owner.port });
      const instance = new WebAssembly.Instance(module, imports.imports);
      imports.bind(instance);
      const run = (WebAssembly as unknown as { promising: Promising }).promising(
        instance.exports.run as (source: number, resultPointer: number) => number,
      );

      expect(await run(fd, 65_534)).toBe(21);
      expect(Array.from(fixture.filesystem.descriptors.entries())).toHaveLength(before);
    } finally {
      fixture.filesystem.close(fd);
      await owner.close();
      await fixture.close();
    }
  });
});

interface Promising {
  (run: (...args: number[]) => number): (...args: number[]) => Promise<number>;
}

function childImport(
  port: Parameters<typeof createChildCoreutilsImports>[0]["port"],
  namespace: string,
  name: string,
  parameters: readonly ("i32" | "i64")[],
  results: readonly ("i32" | "i64")[],
) {
  const module = wasmImportReactor(namespace, name, parameters, results);
  const imports = createChildCoreutilsImports({ module, port });
  const instance = new WebAssembly.Instance(module, imports.imports);
  imports.bind(instance);
  const run = (WebAssembly as unknown as { promising: Promising }).promising(
    instance.exports.run as (...args: number[]) => number,
  );
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Child import guest lacks memory");
  return { run, memory };
}

function readGuestU32(memory: WebAssembly.Memory, pointer: number): number {
  return new DataView(memory.buffer).getUint32(pointer, true);
}
