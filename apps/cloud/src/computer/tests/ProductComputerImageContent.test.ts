import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import { createProductComputer } from "../ProductComputer.ts";
import { sqliteFixture } from "../sqliteTesting.ts";
import { imageContentInventory } from "./ImageContentFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("public ProductComputer image-content composition", () => {
  it("reads an image symlink through normal kernel permissions without a machine or command loader", async () => {
    const database = sqliteFixture();
    const storage = createFacetSqliteStorage(database.storage, () => 1n);
    storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
    });
    const wakes = new KernelWakeRegistry();
    const forbidden = vi.fn(async () => {
      throw new Error("No machine or command is needed to read image content");
    });
    const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
    const computer = createProductComputer({
      threadId: "image-content-public-composition",
      filesystem,
      wakes,
      capacity: new ChildWorkerCapacity(2),
      programs: {
        bash: code,
        busyboxCat: code,
        busyboxApplets: code,
        ripgrep: code,
        git: code,
        sed: code,
        coreutils: Object.fromEntries(
          CHILD_COREUTILS_COMMANDS.map((name) => [name, code]),
        ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], typeof code>,
      },
      loader: { run: forbidden },
      machineInventory: imageContentInventory(),
      machine: () => ({
        files: {
          current: () => ({ generation: null, generationAbsent: true, pristine: false }),
          markExecuted: forbidden,
          lookup: forbidden,
        },
        spawn: forbidden,
      }),
      signal: new AbortController().signal,
    });
    const syscalls = createKernelSyscallHost({
      filesystem,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const open = async (path: string) => {
      const name = new TextEncoder().encode(path);
      return syscalls.call({
        name: "path_open",
        args: [3, 1, 128, name.byteLength, 0, 2n, 0n, 0, 256],
        memorySize: 1024,
        regions: [
          { pointer: 128, bytes: name, direction: "in" },
          { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 4 },
        ],
      });
    };
    try {
      for (const path of ["etc/link", "etc/config"]) {
        const opened = await open(path);
        expect(opened).toMatchObject({ kind: "return", value: 0 });
        if (opened.kind !== "return") throw new Error("Expected a file descriptor");
        const fdBytes = opened.regions.find((region) => region.pointer === 256)!.bytes;
        const fd = new DataView(fdBytes.buffer, fdBytes.byteOffset, 4).getUint32(0, true);
        const vector = new Uint8Array(8);
        const view = new DataView(vector.buffer);
        view.setUint32(0, 512, true);
        view.setUint32(4, 5, true);
        try {
          const read = await syscalls.call({
            name: "fd_read",
            args: [fd, 128, 1, 256],
            memorySize: 1024,
            regions: [
              { pointer: 128, bytes: vector, direction: "in" },
              { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 4 },
              { pointer: 512, bytes: new Uint8Array(), direction: "out", length: 5 },
            ],
          });
          expect(read).toMatchObject({ kind: "return", value: 0 });
          if (read.kind !== "return") throw new Error("Expected a file read");
          expect(read.regions.find((region) => region.pointer === 512)!.bytes).toEqual(
            Uint8Array.of(0, 255, 128, 10, 65),
          );
        } finally {
          filesystem.close(fd);
        }
      }
      expect(() => createNodeFs(filesystem).fs.accessSync("/etc/private", 4)).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      syscalls.close();
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    }
  });
});
