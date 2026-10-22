import { describe, expect, it } from "@effect/vitest";

import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { KernelProcessSignal } from "../../kernel/KernelProcessSignal.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { createNodeChildProcess, type NodeChildProcessContext } from "../NodeChildProcess.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

function wasmWriter() {
  const bytes = (value: string) => new TextEncoder().encode(value);
  function leb(value: number) {
    const result: number[] = [];
    do {
      const byte = value & 0x7f;
      value >>>= 7;
      result.push(byte | (value ? 0x80 : 0));
    } while (value);
    return result;
  }
  function name(value: string) {
    const valueBytes = [...bytes(value)];
    return [...leb(valueBytes.length), ...valueBytes];
  }
  function section(id: number, value: number[]) {
    return [id, ...leb(value.length), ...value];
  }
  const constant = (value: number) => [0x41, ...leb(value)];
  const body = [0, ...[1, 0, 1, 12].flatMap(constant), 0x10, 0, 0x10, 1, 0x0b];
  const data = [16, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 121];

  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [3, 0x60, 4, 127, 127, 127, 127, 1, 127, 0x60, 1, 127, 0, 0x60, 0, 0]),
      ...section(2, [
        2,
        ...name("wasi_snapshot_preview1"),
        ...name("fd_write"),
        0,
        0,
        ...name("wasi_snapshot_preview1"),
        ...name("proc_exit"),
        0,
        1,
      ]),
      ...section(3, [1, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 2]),
      ...section(10, [1, ...leb(body.length), ...body]),
      ...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(data.length), ...data]),
    ]),
  );
}

function harness() {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const pipe = new KernelPipe(wakes, 4096);
  pipe.closeReader();
  let writeAttempts = 0;
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
    stdio: [
      {},
      {
        write(source) {
          writeAttempts++;
          return pipe.tryWrite(source);
        },
      },
      {},
    ],
  });
  filesystem.mkdir("/work");
  filesystem.chdir("/work");

  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "sync-writer",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: [] as const,
    entrypoint: "sync-writer",
  };
  const shellManifest = { ...manifest, name: "sync-shell" };
  if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
  if (registry.register(shellManifest).status !== "ok")
    throw new Error("Shell registration failed");
  const implementation = { kind: "wasm" as const, module: wasmWriter() };
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      ["/bin/writer", { manifest, implementation }],
      ["/bin/sh", { manifest: shellManifest, implementation }],
    ]),
  });
  const context: NodeChildProcessContext = {
    filesystem,
    env: { PATH: "/bin", HOME: "/work/home" },
    home: "/work/home",
  };

  return {
    childProcess: createNodeChildProcess(host, context),
    get writeAttempts() {
      return writeAttempts;
    },
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

describe("Node synchronous child signal results", () => {
  it("returns SIGPIPE from spawnSync without exposing the kernel signal error", async () => {
    const host = harness();
    try {
      const result = host.childProcess.spawnSync("/bin/writer", [], { stdio: "inherit" });

      expect(result).toMatchObject({ status: null, signal: "SIGPIPE" });
      expect(result.error).toBeUndefined();
      expect(host.writeAttempts).toBe(1);
    } finally {
      await host.close();
    }
  });

  it.each(["execSync", "execFileSync"] as const)(
    "throws an ordinary child error with signal metadata from %s",
    async (method) => {
      const host = harness();
      try {
        let thrown: unknown;
        try {
          if (method === "execSync") {
            host.childProcess.execSync("write", { stdio: "inherit" });
          } else {
            host.childProcess.execFileSync("/bin/writer", [], { stdio: "inherit" });
          }
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(KernelProcessSignal);
        expect(thrown).toMatchObject({
          status: null,
          signal: "SIGPIPE",
          stdout: null,
          stderr: null,
        });
        expect(host.writeAttempts).toBe(1);
      } finally {
        await host.close();
      }
    },
  );
});
