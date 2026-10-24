import { describe, expect, it, vi } from "vite-plus/test";
import type { MachineFileStat } from "@signalbox/runner-protocol/MachineFilesProtocol";
import { createComputerMachineFileSystem } from "../ComputerMachineFileSystem.ts";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";

const inventory = machineInventoryFixture([{ path: "/usr/bin/tool", mode: 0o755, uid: 0, gid: 0 }]);
const stat: MachineFileStat = {
  type: "file",
  mode: 0o100751,
  uid: 1000,
  gid: 1001,
  size: "118456",
  nlink: "1",
  dev: "7",
  ino: "29",
  atimeNs: "1234567890123456789",
  mtimeNs: "1234567890123456788",
  ctimeNs: "1234567890123456787",
  birthtimeNs: "0",
};
const signal = new AbortController().signal;

describe("Computer machine filesystem sources", () => {
  it("proves pristine presence and absence without contacting the machine", async () => {
    const files: MachineFilesPort = {
      current: () => ({ generation: null, pristine: true, imageDigest: inventory.imageDigest }),
      markExecuted: async () => {},
      lookup: vi.fn(async () => {
        throw new Error("A fresh typo started a machine");
      }),
    };
    const source = createComputerMachineFileSystem({ inventory, files, signal });
    expect(await source.lookup(["/usr/bin/tool", "/usr/bin/missing"])).toMatchObject([
      {
        path: "/usr/bin/tool",
        stat: { type: "file", size: 0n },
        metadata: { mode: 0o755, uid: 0, gid: 0 },
      },
      undefined,
    ]);
    expect(await source.readdir("/usr/bin")).toMatchObject([{ path: "/usr/bin/tool" }]);
    expect(files.lookup).not.toHaveBeenCalled();
  });

  it.each([undefined, `sha256:${"a".repeat(64)}`])(
    "uses live metadata when the pristine image identity is %s",
    async (imageDigest) => {
      const files: MachineFilesPort = {
        current: () => ({
          generation: 1,
          pristine: true,
          ...(imageDigest === undefined ? {} : { imageDigest }),
        }),
        markExecuted: async () => {},
        lookup: vi.fn<MachineFilesPort["lookup"]>(async (input) => ({
          generation: input.generation,
          results: input.operations.map((operation) => ({ id: operation.id, op: "lstat", stat })),
        })),
      };
      const source = createComputerMachineFileSystem({ inventory, files, signal });
      expect((await source.lookup(["/usr/bin/tool"]))[0]?.stat.size).toBe(118456n);
      expect(files.lookup).toHaveBeenCalledOnce();
    },
  );

  it("lists runtime mount children through the live source on a pristine machine", async () => {
    const files: MachineFilesPort = {
      current: () => ({ generation: 1, pristine: true, imageDigest: inventory.imageDigest }),
      markExecuted: async () => {},
      lookup: vi.fn<MachineFilesPort["lookup"]>(async (input) => ({
        generation: input.generation,
        results: [
          {
            id: "directory",
            op: "readdir",
            entries: [{ name: "hosts", type: stat.type, stat }],
            nextCursor: null,
          },
        ],
      })),
    };
    const source = createComputerMachineFileSystem({
      inventory: { ...inventory, excludedRoots: ["/etc/hosts"] },
      files,
      signal,
    });
    expect(await source.readdir("/etc")).toMatchObject([
      { path: "/etc/hosts", stat: { size: 118456n } },
    ]);
    expect(files.lookup).toHaveBeenCalledOnce();
  });

  it("reads the current machine after execution, including newly installed and removed paths", async () => {
    let pristine = true;
    const files: MachineFilesPort = {
      current: () => ({ generation: 1, pristine, imageDigest: inventory.imageDigest }),
      markExecuted: async () => {
        pristine = false;
      },
      lookup: vi.fn<MachineFilesPort["lookup"]>(async (input) => ({
        generation: input.generation,
        results: input.operations.map((operation) =>
          operation.op === "lstat" && operation.path === "/home/node/.local/bin/new-tool"
            ? { id: operation.id, op: "lstat", stat }
            : { id: operation.id, op: operation.op, error: { code: "ENOENT", message: "Absent" } },
        ),
      })),
    };
    const source = createComputerMachineFileSystem({ inventory, files, signal });
    await files.markExecuted(1);
    const entries = await source.lookup(["/usr/bin/tool", "/home/node/.local/bin/new-tool"]);
    expect(entries).toMatchObject([
      undefined,
      {
        path: "/home/node/.local/bin/new-tool",
        stat: { size: 118456n, atimeNs: 1234567890123456789n },
        metadata: { mode: 0o751, uid: 1000, gid: 1001 },
        nativeIno: 29n,
        nativeDev: 7n,
      },
    ]);
    expect(files.lookup).toHaveBeenCalledOnce();
    const reopened = createComputerMachineFileSystem({ inventory, files, signal });
    expect((await reopened.lookup(["/home/node/.local/bin/new-tool"]))[0]?.stat.size).toBe(118456n);
    expect(files.lookup).toHaveBeenCalledTimes(2);
  });

  it("fetches only requested file bytes and never returns an inventory placeholder", async () => {
    const files: MachineFilesPort = {
      current: () => ({ generation: 2, pristine: true, imageDigest: inventory.imageDigest }),
      markExecuted: async () => {},
      lookup: vi.fn<MachineFilesPort["lookup"]>(async (input) => ({
        generation: input.generation,
        results: [
          {
            id: "bytes",
            op: "readRange",
            offset: 0,
            bytesRead: 4,
            bytesBase64: "f0VMRg==",
            eof: false,
          },
        ],
      })),
    };
    const source = createComputerMachineFileSystem({ inventory, files, signal });
    await source.lookup(["/usr/bin/tool"]);
    expect(files.lookup).not.toHaveBeenCalled();
    expect(await source.read("/usr/bin/tool", 0n, 4)).toEqual(
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
    );
    expect(files.lookup).toHaveBeenCalledWith(
      {
        generation: 2,
        operations: [{ id: "bytes", op: "readRange", path: "/usr/bin/tool", offset: 0, length: 4 }],
      },
      signal,
    );
  });

  it("fails unavailable or incomplete live lookups without claiming absence", async () => {
    const lookup = vi.fn<MachineFilesPort["lookup"]>();
    const files: MachineFilesPort = {
      current: () => ({ generation: 1, pristine: false }),
      markExecuted: async () => {},
      lookup,
    };
    const source = createComputerMachineFileSystem({ inventory, files, signal });
    lookup.mockRejectedValueOnce(
      new MachineFileLookupError("BACKEND_UPGRADE_REQUIRED", "Runner must be upgraded"),
    );
    await expect(source.lookup(["/usr/bin/missing"])).rejects.toMatchObject({
      name: "KernelFileSystemUnavailable",
    });
    lookup.mockResolvedValueOnce({ generation: 1, results: [] });
    await expect(source.lookup(["/usr/bin/missing"])).rejects.toMatchObject({
      name: "KernelFileSystemUnavailable",
    });
  });
});
