import type { Computer } from "../../src/computer/Computer.ts";
import {
  createHarnessNodeBuiltinInventory,
  inspectNodeBuiltinFunctionCapabilities,
  type NodeBuiltinFunctionCapability,
  type NodeBuiltinFunctionRequest,
  type NodeBuiltinTargetProfile,
} from "../../src/harness/NodeBuiltinInventory.ts";
import { KernelProgramRegistry, KernelWakeRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { createKernelSessionStdio } from "../../src/kernel/KernelSessionStdio.ts";
import type { NodeNativeRuntimeProfile } from "../../src/harness/NodeNativeBuiltinCapabilities.ts";

function forbidden(): never {
  throw new Error("Builtin inventory must not execute, access the network, or persist state");
}

export interface CapturedRuntimeBuiltinInventory {
  readonly modules: Readonly<Record<string, object>>;
  readonly functions: readonly NodeBuiltinFunctionCapability[];
  readonly profile: NodeBuiltinTargetProfile;
}

export function parseFunctionRequests(
  serialized: string | undefined,
): readonly NodeBuiltinFunctionRequest[] {
  if (serialized === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("NODE_BUILTIN_RUNTIME_REQUEST_INVALID");
  }
  if (!Array.isArray(value)) throw new Error("NODE_BUILTIN_RUNTIME_REQUEST_INVALID");
  return value.map((request) => {
    if (!request || typeof request !== "object")
      throw new Error("NODE_BUILTIN_RUNTIME_REQUEST_INVALID");
    const specifier = Reflect.get(request, "specifier");
    const memberPath = Reflect.get(request, "memberPath");
    if (typeof specifier !== "string" || !specifier || !isMemberPath(memberPath))
      throw new Error("NODE_BUILTIN_RUNTIME_REQUEST_INVALID");
    return { specifier, memberPath };
  });
}

function isMemberPath(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((member: unknown) => typeof member === "string" && member.length > 0)
  );
}

/** Returned objects are for inspection only: their runtime is disposed before this resolves. */
export async function captureRuntimeBuiltinInventory(
  requiredFunctions: readonly NodeBuiltinFunctionRequest[] = [],
  nativeRuntime?: NodeNativeRuntimeProfile,
): Promise<CapturedRuntimeBuiltinInventory> {
  const resources = new AsyncDisposableStack();
  const lifetime = new AbortController();
  try {
    const wakes = new KernelWakeRegistry();
    resources.defer(() => wakes.dispose());
    const stdio = createKernelSessionStdio(wakes, lifetime.signal);
    resources.defer(() => stdio.dispose());
    const files = new KernelFileSystem({
      mounts: [],
      stdio: stdio.stdio,
      posix: {
        credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000, groups: [] },
        umask: 0o022,
      },
    });
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
      nativeRuntime,
    );
    resources.defer(() => inventory.dispose());
    return {
      modules: inventory.modules,
      functions: inspectNodeBuiltinFunctionCapabilities(
        inventory.modules,
        requiredFunctions,
        inventory.profile,
      ),
      profile: inventory.profile,
    };
  } finally {
    lifetime.abort();
    await resources.disposeAsync();
  }
}

if (import.meta.main) {
  const { captureWorkerdBuiltinInventory } = await import("./workerdBuiltinInventory.ts");
  const inventory = await captureWorkerdBuiltinInventory(parseFunctionRequests(process.argv[2]));
  process.stdout.write(JSON.stringify(inventory) + "\n");
}
