import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  kernelOk,
  type KernelHandle,
  type RegisteredProgram,
} from "../KernelAbi.ts";
import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramHostOptions } from "../KernelProgramHost.ts";
import type { KernelExitStatus } from "../KernelProcessTable.ts";
import { KernelProcessTable } from "../KernelProcessTable.ts";
import type { KernelAsyncProgram } from "../KernelAsyncProgram.ts";
import type { KernelProgramBinding } from "../KernelProgramHost.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

const now = () => 1_800_000_000_000_000_001n;
const encoder = new TextEncoder();

export function manifest(name: string): RegisteredProgram {
  return {
    name,
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: [],
    entrypoint: name,
  };
}

export function asyncBinding(name: string, run: KernelAsyncProgram["run"]): KernelProgramBinding {
  return { manifest: manifest(name), implementation: { kind: "async", run } };
}

export function text(value: string): Uint8Array {
  return encoder.encode(value);
}

export function createAdmissionKernel(
  programs: ReadonlyMap<string, KernelProgramBinding>,
  options: Omit<KernelProgramHostOptions, "registry" | "wakes" | "programs" | "processes"> & {
    readonly maxProcesses?: number;
  } = {},
) {
  const sqlite = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(sqlite.storage, now) }],
  });
  filesystem.mkdir("/work");
  filesystem.mkdir("/elsewhere");
  const registry = new KernelProgramRegistry();
  for (const binding of programs.values()) {
    if (registry.register(binding.manifest).status !== "ok") {
      throw new Error(`Program registration failed: ${binding.manifest.name}`);
    }
  }
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({
    wakes,
    ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
  });
  const { maxProcesses: _maxProcesses, ...hostOptions } = options;
  void _maxProcesses;
  const host = new KernelProgramHost({ ...hostOptions, registry, wakes, processes, programs });
  return {
    host,
    filesystem,
    async startRoot(path: string, signal = new AbortController().signal) {
      const resolved = host.resolve(path);
      if (resolved.status !== "ok") throw new Error(`Could not resolve ${path}`);
      const prepared = host.prepare({ filesystem, signal });
      const result = callKernel(host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      await prepared.release();
      if (result.status !== "ok") throw new Error(`Could not spawn ${path}`);
      return result.value;
    },
    async startParent() {
      const completion = Promise.withResolvers<KernelExitStatus>();
      const parent = host.processes.spawn(
        undefined,
        () => ({ completion: completion.promise, signal: () => kernelOk(undefined) }),
        () => {},
      );
      if (parent.status !== "ok") throw new Error("Could not start admission test parent");
      return { handle: parent.value.handle, finish: () => completion.resolve(exitStatus(0)) };
    },
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      sqlite.close();
    },
  };
}

export function seedFile(filesystem: KernelFileSystem, path: string, contents: string): void {
  const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
  filesystem.write(fd, text(contents), null);
  filesystem.close(fd);
}

export function readFile(filesystem: KernelFileSystem, path: string): string {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  const bytes = new Uint8Array(4096);
  const size = filesystem.read(fd, bytes, 0n);
  filesystem.close(fd);
  return new TextDecoder().decode(bytes.subarray(0, size));
}

export function openFileForWrite(filesystem: KernelFileSystem, path: string): number {
  return filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
}

export function exitStatus(exitCode: number): KernelExitStatus {
  return { exitCode, signal: 0, coreDumped: false };
}

export type AsyncRun = Extract<KernelProgramBinding["implementation"], { kind: "async" }>["run"];
export type ProcessHandle = KernelHandle<"process">;
