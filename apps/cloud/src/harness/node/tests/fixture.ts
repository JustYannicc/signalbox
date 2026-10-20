import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import * as NodeChildProcess from "node:child_process";
import * as Yaml from "yaml";
import * as NodeTest from "node:test";
import type { Computer } from "../../../computer/Computer.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../kernel/KernelProgramHost.ts";
import { KernelProgramRegistry, KernelWakeRegistry, kernelOk } from "../../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { createKernelSessionStdio } from "../../../kernel/KernelSessionStdio.ts";
import type { KernelCommandChild } from "../../../kernel/KernelCommandForwarder.ts";
import type { NodeHarnessProcessInput } from "../../NodeHarnessProcess.ts";
import type { createNodeProcess } from "../../../isolate/NodeProcess.ts";
import type { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { createNodeChildProcess } from "../../../isolate/NodeChildProcess.ts";
import { createNodeModule } from "../../../isolate/NodeModule.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export function outputChild(bytes = new Uint8Array([255, 0, 128])): KernelCommandChild {
  const output = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
  return {
    stdin: new WritableStream(),
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    stderr: output(),
    exited: Promise.resolve({ exitCode: 0, signal: 0, coreDumped: false }),
    signal: async () => kernelOk(undefined),
    dispose: async () => {},
  };
}

export function fixture() {
  const database = sqliteFixture();
  const storage = database.storage;
  const wakes = new KernelWakeRegistry();
  const stdio = createKernelSessionStdio(wakes);
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(storage, () => 1n) }],
    stdio: stdio.stdio,
  });
  files.mkdir("/work");
  files.mkdir("/work/sub");
  files.chdir("/work");
  stdio.assertBound(files);
  const host = new KernelProgramHost({ wakes, registry: new KernelProgramRegistry() });
  const exec = NodeTest.mock.fn<Computer["exec"]>(async () => outputChild());
  const computer: Computer = {
    files,
    threadId: "test-thread",
    exec,
    port: async () => {
      throw new Error("No test port");
    },
    save: async () => {
      throw new Error("No test save");
    },
  };
  const input: NodeHarnessProcessInput = {
    host,
    computer,
    stdio,
    identity: {
      version: "v24.21.0",
      versions: { node: "24.21.0", bun: "1.3.11" },
      platform: "linux",
      arch: "x64",
      type: "Linux",
      endianness: "LE",
      availableParallelism: 1,
      user: { username: "test", uid: 1000, gid: 1000, shell: "/bin/bash" },
      homedir: "/home/test",
      tmpdir: "/tmp",
      pid: 100,
      ppid: 0,
      execPath: "/runtime/claude",
      argv0: "claude",
      argv: ["claude", "/release/cli", "--input-format", "stream-json"],
    },
    env: { HOME: "/home/test", PATH: "/bin", ONLY: "exact" },
    nativeModules: {
      buffer: NodeBuffer,
      constants: NodeConstants,
      fs: NodeFS,
      child_process: NodeChildProcess,
    },
    loadPackages: async () => ({ yaml: Yaml }),
    loadRelease: async () => ({ launch() {} }),
    bun: { main: "/release/cli", version: "1.3.11", revision: "test" },
    modelTransport: async () => {
      throw new Error("Unexpected model request");
    },
  };
  return {
    input,
    files,
    host,
    wakes,
    stdio,
    exec,
    async close() {
      await host.processes.dispose();
      await stdio.dispose();
      files.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

export type GuestProcess = ReturnType<typeof createNodeProcess>;
export type GuestFs = ReturnType<typeof createNodeFs>["fs"];
export type GuestChildren = ReturnType<typeof createNodeChildProcess>;
export type GuestModule = ReturnType<typeof createNodeModule>;
