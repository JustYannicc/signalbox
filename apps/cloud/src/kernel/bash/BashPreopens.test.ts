import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../KernelFileSystem.ts";
import { sqliteFixture } from "../tests/sqliteFixture.ts";
import { wasmImportReactor } from "../tests/wasmGuest.ts";
import { WasiLifecycle } from "../wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "../wasi/internal_wasi_options.ts";
import { RIGHTS } from "../wasi/internal_wasi_descriptors.ts";
import { BashPreopens } from "./BashPreopens.ts";

function setup() {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 1n) }],
  });
  filesystem.mkdir("/workspace");
  const preopens = new BashPreopens(filesystem.descriptors);
  return {
    filesystem,
    preopens,
    close: () => {
      filesystem.dispose();
      fixture.close();
    },
  };
}

async function openThroughCachedRoot(
  filesystem: KernelFileSystem,
  preopens: BashPreopens,
  path: string,
) {
  const lifecycle = new WasiLifecycle(
    validateOptions({ version: "preview1", mounts: [], returnOnExit: true }),
    true,
    { table: filesystem.descriptors, ownership: "borrowed" },
    preopens.transformArguments,
  );
  const instance = new WebAssembly.Instance(
    wasmImportReactor(
      "wasi_snapshot_preview1",
      "path_open",
      ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
      ["i32"],
    ),
    lifecycle.getImportObject(),
  );
  await lifecycle.initializeAsync(instance);
  const memory = instance.exports.memory;
  const run = instance.exports.run;
  if (!(memory instanceof WebAssembly.Memory) || typeof run !== "function")
    throw new Error("Invalid WASI fixture");
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(memory.buffer).set(bytes, 64);
  try {
    const imported = run as (...args: Array<number | bigint>) => unknown;
    expect(
      await lifecycle.runAsync(imported, 3, 1, 64, bytes.length, 9, RIGHTS.FD_WRITE, 0n, 0, 128),
    ).toBe(0);
    return new DataView(memory.buffer).getUint32(128, true);
  } finally {
    await lifecycle.closeAsync();
  }
}

describe("Bash cached preopen relocation", () => {
  it("keeps path_open usable after redirection claims the cached root fd", async () => {
    const context = setup();
    try {
      const log = context.filesystem.open(
        "/workspace/log",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      expect(await context.preopens.duplicateTo(log, 3)).toBe(3);
      context.filesystem.close(log);
      context.filesystem.write(3, new TextEncoder().encode("log"), null);
      const result = await openThroughCachedRoot(
        context.filesystem,
        context.preopens,
        "workspace/result",
      );
      context.filesystem.write(result, new TextEncoder().encode("ok"), null);
      context.filesystem.close(result);
      expect(context.filesystem.stat("/workspace/log").size).toBe(3n);
      expect(context.filesystem.stat("/workspace/result").size).toBe(2n);
    } finally {
      context.close();
    }
  });

  it("copies cached fd relocation into a fork without changing the parent's handles", async () => {
    const context = setup();
    let child: KernelFileSystem | undefined;
    try {
      const log = context.filesystem.open(
        "/workspace/log",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      await context.preopens.duplicateTo(log, 3);
      const parentTable = context.filesystem.descriptors;
      const table = parentTable.fork(
        [...parentTable.entries()].map(([fd]) => ({ parentFd: fd, childFd: fd })),
        { exec: false },
      );
      child = context.filesystem.fork(table);
      const inherited = new BashPreopens(table, context.preopens);
      const result = await openThroughCachedRoot(child, inherited, "workspace/child-result");
      child.close(result);
      child.close(3);
      expect(parentTable.has(3)).toBe(true);
      expect(context.filesystem.stat("/workspace/child-result").type).toBe("file");
    } finally {
      if (child !== undefined) {
        for (const [fd] of [...child.descriptors.entries()]) child.close(fd);
        child.dispose();
      }
      context.close();
    }
  });
});
