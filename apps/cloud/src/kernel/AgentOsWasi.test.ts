import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { createAgentOsWasiArgumentTransform } from "./AgentOsWasi.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const now = () => 1_800_000_000_000_000_001n;
const HIDDEN_PREOPEN_TAG = 0x4000_0000;

describe("AgentOS WASI hidden preopen arguments", () => {
  it("maps only tagged preopen operands at their pinned WASI argument positions", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/workspace", storage }] });
    try {
      const preopenFd = getPreopenFd(filesystem);
      const transform = createAgentOsWasiArgumentTransform(filesystem);
      const tagged = HIDDEN_PREOPEN_TAG | preopenFd;
      const positions: Readonly<Record<string, readonly number[]>> = {
        fd_prestat_get: [0],
        fd_prestat_dir_name: [0],
        path_create_directory: [0],
        path_filestat_get: [0],
        path_filestat_set_times: [0],
        path_link: [0, 4],
        path_open: [0],
        path_readlink: [0],
        path_remove_directory: [0],
        path_rename: [0, 3],
        path_symlink: [2],
        path_unlink_file: [0],
      };

      for (const [name, indexes] of Object.entries(positions)) {
        const args = Array<number>(7).fill(12);
        for (const index of indexes) args[index] = tagged;
        const expected = [...args];
        for (const index of indexes) expected[index] = preopenFd;
        expect(transform(name, args), name).toEqual(expected);
      }
      const untouched = [tagged, 1, 2, 3];
      expect(transform("fd_close", untouched)).toBe(untouched);
      expect(transform("path_open", [0x8000_0000 | preopenFd])).toEqual([0x8000_0000 | preopenFd]);
      expect(transform("fd_prestat_get", [HIDDEN_PREOPEN_TAG | 0x3fff_ffff])).toEqual([
        HIDDEN_PREOPEN_TAG | 0x3fff_ffff,
      ]);
    } finally {
      filesystem.dispose();
      fixture.close();
    }
  });

  it("uses the transform at real WASI imports without changing descriptor authority", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/workspace", storage }] });
    const wakes = new KernelWakeRegistry();
    const runners: WasiImportRunner[] = [];
    try {
      const preopenFd = getPreopenFd(filesystem);
      expect(preopenFd).toBe(3);
      const ordinaryFd = filesystem.open(
        "/workspace/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDONLY,
      );
      const taggedPreopen = HIDDEN_PREOPEN_TAG | preopenFd;

      const wasi = await wasiRunner(filesystem, wakes, "fd_prestat_get", ["i32", "i32"], true);
      runners.push(wasi);
      expect(await wasi.run(taggedPreopen, 64)).toBe(0);
      expect(new DataView(wasi.memory.buffer).getUint32(68, true)).toBe("/workspace".length);

      const dirName = await wasiRunner(
        filesystem,
        wakes,
        "fd_prestat_dir_name",
        ["i32", "i32", "i32"],
        true,
      );
      runners.push(dirName);
      expect(await dirName.run(taggedPreopen, 64, 32)).toBe(0);
      expect(new TextDecoder().decode(new Uint8Array(dirName.memory.buffer, 64, 10))).toBe(
        "/workspace",
      );

      const stat = await wasiRunner(
        filesystem,
        wakes,
        "path_filestat_get",
        ["i32", "i32", "i32", "i32", "i32"],
        true,
      );
      runners.push(stat);
      writeGuestPath(stat.memory, 64, ".");
      expect(await stat.run(taggedPreopen, 0, 64, 1, 128)).toBe(0);
      expect(new DataView(stat.memory.buffer).getUint8(144)).toBe(3);

      const raw = await wasiRunner(filesystem, wakes, "fd_prestat_get", ["i32", "i32"]);
      runners.push(raw);
      expect(await raw.run(taggedPreopen, 64)).toBe(8);

      const taggedOrdinary = HIDDEN_PREOPEN_TAG | ordinaryFd;
      expect(await wasi.run(taggedOrdinary, 64)).toBe(8);
      expect(await wasi.run(HIDDEN_PREOPEN_TAG, 64)).toBe(8);
      expect(await wasi.run(HIDDEN_PREOPEN_TAG | 0x3fff_ffff, 64)).toBe(8);

      const close = await wasiRunner(filesystem, wakes, "fd_close", ["i32"], true);
      runners.push(close);
      expect(await close.run(taggedPreopen)).toBe(8);
      expect(await wasi.run(taggedPreopen, 64)).toBe(0);

      const getStat = await wasiRunner(filesystem, wakes, "fd_fdstat_get", ["i32", "i32"], true);
      runners.push(getStat);
      expect(await getStat.run(preopenFd, 64)).toBe(0);
      const descriptorStat = new DataView(getStat.memory.buffer);
      const rightsBase = descriptorStat.getBigUint64(72, true);
      const rightsInheriting = descriptorStat.getBigUint64(80, true);
      const setRights = await wasiRunner(
        filesystem,
        wakes,
        "fd_fdstat_set_rights",
        ["i32", "i64", "i64"],
        true,
      );
      runners.push(setRights);
      expect(await setRights.run(preopenFd, rightsBase & ~(1n << 18n), rightsInheriting)).toBe(0);
      expect(await stat.run(taggedPreopen, 0, 64, 1, 128)).toBe(76);

      const restrictedAlias = filesystem.descriptors.duplicate(preopenFd);
      expect(await stat.run(HIDDEN_PREOPEN_TAG | restrictedAlias, 0, 64, 1, 128)).toBe(76);
      expect(await setRights.run(restrictedAlias, rightsBase, rightsInheriting)).toBe(76);
    } finally {
      await Promise.allSettled(runners.map((runner) => runner.close()));
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });
});

interface WasiImportRunner {
  readonly memory: WebAssembly.Memory;
  run(...args: Array<number | bigint>): Promise<number>;
  close(): Promise<void>;
}

function getPreopenFd(filesystem: KernelFileSystem): number {
  const preopen = [...filesystem.descriptors.entries()].find(
    ([, descriptor]) => descriptor.preopen === true && descriptor.kind === "directory",
  )?.[0];
  if (preopen === undefined) throw new Error("Workspace preopen is missing");
  return preopen;
}

async function wasiRunner(
  filesystem: KernelFileSystem,
  wakes: KernelWakeRegistry,
  importName: string,
  params: readonly ("i32" | "i64")[],
  agentOsPreopens = false,
): Promise<WasiImportRunner> {
  const wasi = createKernelAsyncWasi({ filesystem, wakes, agentOsPreopens });
  const instance = new WebAssembly.Instance(
    wasmImportReactor("wasi_snapshot_preview1", importName, params, ["i32"]),
    wasi.wasi.getImportObject(),
  );
  await wasi.wasi.initialize(instance);
  const run = instance.exports.run as (...args: Array<number | bigint>) => unknown;
  const memory = instance.exports.memory as WebAssembly.Memory;
  return {
    memory,
    run: (...args) => wasi.wasi.run(run, ...args) as Promise<number>,
    close: () => wasi.wasi.close(),
  };
}

function writeGuestPath(memory: WebAssembly.Memory, pointer: number, path: string): void {
  const encoded = new TextEncoder().encode(path);
  new Uint8Array(memory.buffer, pointer, encoded.byteLength).set(encoded);
}
