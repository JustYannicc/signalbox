import { describe, expect, it } from "vite-plus/test";
import { createComputerMachineProfile } from "../ComputerMachineProfile.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";
import type { KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";

describe("Computer machine change counter", () => {
  it("moves when a machine command starts and again once its exit refresh lands", async () => {
    const owned = createTestFilesystem();
    const exit = Promise.withResolvers<KernelCommandExit>();
    const signal = new AbortController().signal;
    const profile = createComputerMachineProfile({
      filesystem: owned.filesystem,
      threadId: "machine-changes",
      machineInventory: machineInventoryFixture(),
      transport: {
        files: {
          current: () => ({ generation: 1, pristine: false }),
          markExecuted: async () => {},
          lookup: async (input) => ({ generation: input.generation, results: [] }),
        },
        spawn: async () => ({
          generation: 1,
          stdin: new WritableStream(),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: exit.promise,
          signal: async () => ({ status: "ok", value: undefined }),
          dispose: async () => {},
        }),
      },
      signal,
    });
    try {
      expect(profile.machineChanges()).toEqual({ changes: 0, running: 0 });
      const child = await profile.machine.spawn(
        { executable: "/bin/true", argv: ["true"], cwd: "/", env: {} },
        signal,
      );
      expect(profile.machineChanges()).toEqual({ changes: 1, running: 1 });
      exit.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await child.exited.catch(() => undefined);
      // A reader that indexed while the command ran must see that the lower layer moved again.
      expect(profile.machineChanges()).toEqual({ changes: 2, running: 0 });
    } finally {
      owned.close();
    }
  });
});
