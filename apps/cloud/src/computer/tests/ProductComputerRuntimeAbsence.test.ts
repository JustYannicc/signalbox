import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { RunnerMachineFileLookupForwarder } from "../MachineFileLookupForwarder.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { createProductComputer } from "../ProductComputer.ts";
import { sqliteFixture } from "../sqliteTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function bootComputer(absent: boolean) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  const fs = createNodeFs(filesystem).fs;
  fs.mkdirSync("/tmp", { mode: 0o1777 });
  const wakes = new KernelWakeRegistry();
  const files = new RunnerMachineFileLookupForwarder({
    ...(absent
      ? {
          source: {
            current: () => ({ generation: null, generationAbsent: true as const, pristine: false }),
            markExecuted: async () => {
              throw new Error("No machine generation");
            },
          },
        }
      : {}),
  });
  const lookup = vi.spyOn(files, "lookup");
  const spawn = vi.fn(async () => {
    throw new Error("This boot composition cannot create a machine");
  });
  const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
  const computer = createProductComputer({
    threadId: `runtime-absence-${absent}`,
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
      coreutils: {
        cp: code,
        echo: code,
        head: code,
        ls: code,
        mkdir: code,
        mv: code,
        printf: code,
        pwd: code,
        rm: code,
        tail: code,
      },
    },
    loader: {
      run: async () => {
        throw new Error("Boot must not start commands");
      },
    },
    machineInventory: { ...machineInventoryFixture(), excludedRoots: ["/tmp"] },
    machine: () => ({ files, spawn }),
    signal: new AbortController().signal,
  });
  return {
    fs,
    files,
    lookup,
    spawn,
    async close() {
      await computer.close();
      await files.dispose();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}

describe("ProductComputer no-machine boot input", () => {
  it("creates the official CLI temp directory from owner-attested absence", async () => {
    const boot = bootComputer(true);
    try {
      expect(boot.fs.mkdirSync("/tmp/claude-1000", { recursive: true, mode: 0o700 })).toBe(
        "/tmp/claude-1000",
      );
      const fd = boot.fs.openSync("/tmp/claude-1000", 0x10000 | 0x20000);
      try {
        expect(boot.fs.fstatSync(fd).uid).toBe(1000);
        expect(boot.fs.fstatSync(fd).mode & 0o777).toBe(0o700);
      } finally {
        boot.fs.closeSync(fd);
      }
      boot.fs.writeFileSync("/tmp/claude-1000/settings.json", "settings");
      expect(boot.fs.readFileSync("/tmp/claude-1000/settings.json", "utf8")).toBe("settings");
      expect(boot.lookup).not.toHaveBeenCalled();
      expect(boot.spawn).not.toHaveBeenCalled();
    } finally {
      await boot.close();
    }
  });

  it.each(["unknown", "disconnected"])("keeps %s input fail closed", async (state) => {
    const boot = bootComputer(false);
    if (state === "disconnected") {
      const socket = {} as WebSocket;
      boot.files.connected(socket, {
        generation: 1,
        connection: 1,
        protocolVersion: 8,
        exec: true,
        machineFileLookup: true,
        send: vi.fn(),
      });
      boot.files.disconnected(socket, 1, 1);
    }
    try {
      expect(() => boot.fs.mkdirSync("/tmp/claude-1000", { recursive: true, mode: 0o700 })).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(boot.spawn).not.toHaveBeenCalled();
    } finally {
      await boot.close();
    }
  });
});
