import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createComputerMachineFileSystem } from "../ComputerMachineFileSystem.ts";
import type { MachineFilesPort } from "../MachineFilesPort.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { sqliteFixture } from "../sqliteTesting.ts";

describe("Computer runtime directories", () => {
  it("creates the CLI temp directory synchronously before a machine generation exists", () => {
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
    const files: MachineFilesPort = {
      current: () => ({ generation: null, pristine: false }),
      markExecuted: async () => {},
      lookup: vi.fn(async () => {
        throw new Error("No machine generation exists");
      }),
    };
    const lower = kernel.installLowerFileSystem(
      createComputerMachineFileSystem({
        inventory: { ...machineInventoryFixture(), excludedRoots: ["/tmp"] },
        files,
        signal: new AbortController().signal,
      }),
    );
    try {
      expect(fs.mkdirSync("/tmp/claude-1000", { recursive: true, mode: 0o700 })).toBe(
        "/tmp/claude-1000",
      );
      expect(fs.statSync("/tmp/claude-1000").isDirectory()).toBe(true);
      expect(fs.statSync("/tmp/claude-1000").mode & 0o777).toBe(0o700);
      fs.writeFileSync("/tmp/claude-1000/settings", "settings");
      expect(fs.readFileSync("/tmp/claude-1000/settings", "utf8")).toBe("settings");
      expect(fs.readdirSync("/tmp/claude-1000").map(String)).toEqual(["settings"]);
      expect(files.lookup).not.toHaveBeenCalled();
    } finally {
      lower.dispose();
      kernel.dispose();
      database.close();
    }
  });
});
