import { describe, expect, it, vi } from "vite-plus/test";

import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import { KernelCommandExecutor } from "./KernelCommandExecutor.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "./KernelCommandForwarder.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProgramHost } from "./KernelProgramHost.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const manifest: RegisteredProgram = {
  name: "quiet-tool",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: ["process.spawn"],
  entrypoint: "quiet-tool-1.0.0",
};
const command: KernelCommand = { executable: "/bin/tool", argv: ["tool"], cwd: "/", env: {} };
const exitStatus = { exitCode: 7, signal: 0, coreDumped: false };

describe("Kernel command wake ownership", () => {
  it.each([90_000, 120_000, 180_000])("keeps a quiet command alive for %i ms", async (duration) => {
    vi.useFakeTimers();
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 0n) }],
    });
    const wakes = new KernelWakeRegistry();
    const registry = new KernelProgramRegistry();
    registry.register(manifest);
    const finished = Promise.withResolvers<typeof exitStatus>();
    const started = Promise.withResolvers<void>();
    const host = new KernelProgramHost({
      wakes,
      registry,
      programs: new Map([
        [
          "/bin/tool",
          {
            manifest,
            implementation: {
              kind: "async",
              run: () => {
                started.resolve();
                return finished.promise;
              },
            },
          },
        ],
      ]),
    });
    const forwarder: KernelCommandForwarder = { spawn: vi.fn() };
    const executor = new KernelCommandExecutor({ host, filesystem, forwarder });
    let child: KernelCommandChild | undefined;
    try {
      child = await executor.spawn({ ...command, cwd: "/" }, new AbortController().signal);
      await started.promise;
      const outcome = child.exited.then(
        (value) => ({ status: "ok", value }),
        (error: unknown) => ({ status: "error", error }),
      );
      await vi.advanceTimersByTimeAsync(duration);
      finished.resolve(exitStatus);
      expect(await outcome).toEqual({ status: "ok", value: exitStatus });
      expect(forwarder.spawn).not.toHaveBeenCalled();
      await child.dispose();
      expect(wakes.size).toBe(0);
    } finally {
      finished.resolve(exitStatus);
      await child?.dispose();
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
      vi.useRealTimers();
    }
  });
});
