import type { Computer } from "../../src/computer/Computer.ts";
import { createHarnessNodeBuiltinInventory } from "../../src/harness/NodeBuiltinInventory.ts";
import { KernelProgramRegistry, KernelWakeRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { createKernelSessionStdio } from "../../src/kernel/KernelSessionStdio.ts";

function forbidden(): never {
  throw new Error("Builtin inventory must not execute, access the network, or persist state");
}

/** Returned objects are for inspection only: their runtime is disposed before this resolves. */
export async function captureRuntimeBuiltinInventory(): Promise<Readonly<Record<string, object>>> {
  const resources = new AsyncDisposableStack();
  const lifetime = new AbortController();
  try {
    const wakes = new KernelWakeRegistry();
    resources.defer(() => wakes.dispose());
    const stdio = createKernelSessionStdio(wakes, lifetime.signal);
    resources.defer(() => stdio.dispose());
    const files = new KernelFileSystem({ mounts: [], stdio: stdio.stdio });
    resources.defer(() => files.dispose());
    const host = new KernelProgramHost({
      wakes,
      registry: new KernelProgramRegistry(),
      admit: forbidden,
    });
    resources.defer(async () => {
      const result = await host.processes.dispose();
      if (result.status !== "ok") throw new Error("Builtin inventory process cleanup failed");
    });
    const computer: Computer = {
      threadId: "build-builtin-inventory",
      files,
      exec: forbidden,
      port: forbidden,
      save: forbidden,
    };
    const inventory = createHarnessNodeBuiltinInventory(
      {
        host,
        computer,
        stdio,
        identity: {
          version: "v24.0.0",
          versions: { node: "24.0.0" },
          platform: "linux",
          arch: "x64",
          type: "Linux",
          endianness: "LE",
          availableParallelism: 1,
          user: { username: "build-inventory", uid: 1000, gid: 1000, shell: null },
          homedir: "/",
          tmpdir: "/tmp",
          pid: 1,
          ppid: 0,
          execPath: "/build-inventory/node",
          argv0: "build-inventory",
          argv: ["build-inventory"],
        },
        env: {},
        nativeModules: {},
        loadPackages: forbidden,
        loadRelease: forbidden,
        bun: { main: "/build-inventory", version: "0.0.0", revision: "build-only" },
        modelTransport: forbidden,
      },
      lifetime.signal,
    );
    resources.defer(() => inventory.dispose());
    return inventory.modules;
  } finally {
    lifetime.abort();
    await resources.disposeAsync();
  }
}

if (import.meta.main) {
  const modules = await captureRuntimeBuiltinInventory();
  process.stdout.write(JSON.stringify(Object.keys(modules).sort()) + "\n");
}
