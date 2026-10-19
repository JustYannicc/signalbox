import { describe, expect, it } from "vite-plus/test";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelTscFileSystemPort } from "./KernelTscFileSystem.ts";
import { createKernelTscFileSystem } from "./KernelTscFileSystemHost.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { createKernelTscProgram } from "./KernelTscProgram.ts";
import { runKernelTscReactor } from "./KernelTscReactor.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { tscGuest } from "./tsc/tests/TscWasmFixture.ts";

const encoder = new TextEncoder();
describe("Kernel tsc-rs adapter", () => {
  it("encodes compiler cwd and arguments and creates a fresh reactor each run", async () => {
    const module = tscGuest();
    const filesystem: KernelTscFileSystemPort = {
      execute: async () => ({ kind: "missing" }),
    };
    const instances: WebAssembly.Instance[] = [];
    for (let index = 0; index < 2; index++) {
      const result = await runKernelTscReactor(module, {
        filesystem,
        cwd: "/workspace/project",
        args: ["/bin/tsc-rs", "--pretty", "src/main.ts"],
        host: {
          wasiImports: {},
          initialize: (instance) => {
            instances.push(instance);
          },
          run: (tsRun) => tsRun(),
        },
      });
      expect(result).toBe(7);
      const memory = instances[index]!.exports.memory as WebAssembly.Memory;
      const expected = encoder.encode(
        ["/workspace/project", "0", "--pretty", "src/main.ts"].join("\0"),
      );
      expect(new Uint8Array(memory.buffer, 64, expected.byteLength)).toEqual(expected);
    }
    expect(instances).toHaveLength(2);
    expect(instances[0]).not.toBe(instances[1]);
  });

  it("uses kernel file bytes, follows read symlinks and removes directory trees", async () => {
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 10n) }],
    });
    const port = createKernelTscFileSystem(filesystem);
    try {
      filesystem.mkdir("/workspace");
      await port.execute({
        op: "write",
        path: "/workspace/source.ts",
        data: new Uint8Array([0, 255, 10]),
        append: false,
      });
      filesystem.symlink("/workspace/source.ts", "/workspace/link.ts");
      expect(await port.execute({ op: "read", path: "/workspace/link.ts" })).toEqual({
        kind: "bytes",
        bytes: new Uint8Array([0, 255, 10]),
      });
      await port.execute({
        op: "write",
        path: "/workspace/out/nested/emit.js",
        data: encoder.encode("compiled"),
        append: false,
      });
      expect(await port.execute({ op: "read", path: "/workspace/out/nested/emit.js" })).toEqual({
        kind: "bytes",
        bytes: encoder.encode("compiled"),
      });
      expect(await port.execute({ op: "readDirectory", path: "/workspace" })).toMatchObject({
        kind: "entries",
        entries: [
          { name: "link.ts", kind: "symlink" },
          { name: "out", kind: "directory" },
          { name: "source.ts", kind: "file" },
        ],
      });
      filesystem.symlink("/workspace/source.ts", "/workspace/out/link.ts");
      expect(await port.execute({ op: "remove", path: "/workspace/out" })).toEqual({
        kind: "written",
      });
      expect(await port.execute({ op: "read", path: "/workspace/out/nested/emit.js" })).toEqual({
        kind: "missing",
      });
      expect(await port.execute({ op: "remove", path: "/workspace/out" })).toEqual({
        kind: "written",
      });
      expect(await port.execute({ op: "read", path: "/workspace/source.ts" })).toEqual({
        kind: "bytes",
        bytes: new Uint8Array([0, 255, 10]),
      });
      expect(
        await port.execute({ op: "remove", path: "/workspace/source.ts/child" }),
      ).toMatchObject({ kind: "error", message: expect.stringContaining("not a directory") });
    } finally {
      filesystem.dispose();
      await fixture.close();
    }
  });

  it("closes a trapped invocation's WASI lifecycle without retaining guest descriptors", async () => {
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 10n) }],
    });
    const before = [...filesystem.descriptors.entries()];
    const program = createKernelTscProgram({ module: tscGuest(true) });
    const context = {
      filesystem,
      signal: new AbortController().signal,
      args: ["/bin/tsc-rs"],
      env: {},
    };
    try {
      await expect(
        program.run(context as unknown as KernelAsyncProgramContext),
      ).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
      expect([...filesystem.descriptors.entries()]).toEqual(before);
      expect(
        await createKernelTscProgram({ module: tscGuest() }).run(
          context as unknown as KernelAsyncProgramContext,
        ),
      ).toEqual({ exitCode: 7, signal: 0, coreDumped: false });
      expect([...filesystem.descriptors.entries()]).toEqual(before);
    } finally {
      filesystem.dispose();
      await fixture.close();
    }
  });
});
