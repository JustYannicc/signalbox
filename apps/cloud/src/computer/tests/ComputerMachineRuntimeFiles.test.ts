import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createComputerMachineFileSystem } from "../ComputerMachineFileSystem.ts";
import { RunnerMachineFileLookupForwarder } from "../MachineFileLookupForwarder.ts";
import type { MachineFilesPort } from "../MachineFilesPort.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { sqliteFixture } from "../sqliteTesting.ts";

function runtimeFilesystem(files: MachineFilesPort) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const kernel = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: {
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
      umask: 0o022,
    },
  });
  const fs = createNodeFs(kernel).fs;
  fs.mkdirSync("/tmp", { mode: 0o1777 });
  const source = createComputerMachineFileSystem({
    inventory: { ...machineInventoryFixture(), excludedRoots: ["/tmp"] },
    files,
    signal: new AbortController().signal,
  });
  const lower = kernel.installLowerFileSystem(source);
  return {
    fs,
    source,
    close() {
      lower.dispose();
      kernel.dispose();
      database.close();
    },
  };
}

describe("Computer runtime directories", () => {
  it("creates the CLI temp directory synchronously with trusted generation absence", async () => {
    const files = new RunnerMachineFileLookupForwarder({
      source: {
        current: () => ({ generation: null, generationAbsent: true, pristine: false }),
        markExecuted: async () => {},
      },
    });
    const lookup = vi.spyOn(files, "lookup");
    const test = runtimeFilesystem(files);
    const { fs } = test;
    try {
      expect(fs.mkdirSync("/tmp/claude-1000", { recursive: true, mode: 0o700 })).toBe(
        "/tmp/claude-1000",
      );
      expect(fs.statSync("/tmp/claude-1000").isDirectory()).toBe(true);
      expect(fs.statSync("/tmp/claude-1000").mode & 0o777).toBe(0o700);
      fs.writeFileSync("/tmp/claude-1000/settings", "settings");
      expect(fs.readFileSync("/tmp/claude-1000/settings", "utf8")).toBe("settings");
      expect(fs.readdirSync("/tmp/claude-1000").map(String)).toEqual(["settings"]);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      test.close();
      await files.dispose();
    }
  });

  it.each(["unknown", "disconnected"])(
    "does not infer runtime absence from %s state",
    async (state) => {
      const files = new RunnerMachineFileLookupForwarder();
      if (state === "disconnected") {
        const socket = {} as WebSocket;
        files.connected(socket, {
          generation: 4,
          connection: 2,
          protocolVersion: 8,
          exec: true,
          machineFileLookup: true,
          send: vi.fn(),
        });
        files.disconnected(socket, 4, 2);
      }
      const test = runtimeFilesystem(files);
      try {
        expect(files.current()).toEqual({ generation: null, pristine: false });
        expect(test.source.lookupKnown?.(["/tmp/claude-1000"])).toBeUndefined();
        expect(() =>
          test.fs.mkdirSync("/tmp/claude-1000", { recursive: true, mode: 0o700 }),
        ).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
        await expect(test.source.lookup(["/tmp/claude-1000"])).rejects.toMatchObject({
          name: "KernelFileSystemUnavailable",
        });
      } finally {
        test.close();
        await files.dispose();
      }
    },
  );
});
