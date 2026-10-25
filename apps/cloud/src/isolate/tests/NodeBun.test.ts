// @effect-diagnostics nodeBuiltinImport:off - PassThrough supplies the explicit Node process streams in this in-memory kernel fixture.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  type KernelCapability,
} from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import {
  KernelProgramHost,
  type KernelInlineProgram,
  type KernelProgramBinding,
} from "../../kernel/KernelProgramHost.ts";
import { sqliteFixture } from "./sqliteFixture.ts";
import { createNodeBunHost } from "../NodeBun.ts";
import { createNodeChildProcess, type NodeChildProcessContext } from "../NodeChildProcess.ts";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeProcess, type NodeProcessHostContext } from "../NodeProcess.ts";
import { BunCapabilityUnavailable, createBunShim } from "../BunShim.ts";

const now = () => 1_800_000_000_000_000_001n;

function harness(options: { readonly maxProcesses?: number } = {}) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, now) }],
  });
  filesystem.mkdir("/workspace");
  filesystem.mkdir("/workspace/bin");
  filesystem.chdir("/workspace");

  const registry = new KernelProgramRegistry();
  const program = binding(registry, {
    name: "test-tool",
    version: "1.0.0",
    abiVersion: ABI_VERSION,
    entrypoint: "test-tool",
    runInline: ({ filesystem: childFilesystem, args }) => {
      const stdout = childFilesystem.descriptors.get(1).stdio?.write;
      const stderr = childFilesystem.descriptors.get(2).stdio?.write;
      if (!stdout || !stderr) throw new Error("The child pipes were not installed");
      void stdout(new TextEncoder().encode(`out:${args.join(",")}`), 0);
      void stderr(new TextEncoder().encode("err"), 0);
      return 17;
    },
  });
  const unsupported = binding(registry, {
    name: "unsupported-tool",
    version: "1.0.0",
    abiVersion: ABI_VERSION,
    entrypoint: "unsupported-tool",
    requiredCapabilities: ["escalate"],
    runInline: () => 0,
  });
  const programHost = new KernelProgramHost({
    registry,
    wakes,
    processes: new KernelProcessTable({ wakes, maxProcesses: options.maxProcesses ?? 256 }),
    programs: new Map([
      ["/workspace/bin/test-tool", program],
      ["/broken/bin/test-tool", unsupported],
    ]),
  });

  const env: Record<string, string | undefined> = {
    PATH: "bin",
    HOME: "/workspace/home",
  };
  const streams = {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
  };
  const stdinDataListenersBeforeBun = streams.stdin.listenerCount("data");
  const processContext: NodeProcessHostContext = {
    filesystem,
    env,
    identity: {
      version: "v24.21.0",
      versions: { node: "24.21.0" },
      platform: "test",
      arch: "test",
      homedir: "/workspace/home",
      tmpdir: "/workspace/tmp",
      pid: 1,
      ppid: 0,
      execPath: "/runtime/node",
      argv0: "node",
      argv: ["node", "/workspace/main.js"],
      main: "/workspace/main.js",
    },
    streams,
    processes: programHost.processes,
  };
  const process = createNodeProcess(processContext);
  const childProcessContext: NodeChildProcessContext = {
    filesystem,
    env: process.env,
    home: "/workspace/home",
  };
  const childProcess = createNodeChildProcess(programHost, childProcessContext);
  const nodeFs = createNodeFs(filesystem);
  const bun = createBunShim(
    createNodeBunHost({
      filesystem: nodeFs,
      process,
      childProcess,
      programHost,
      main: "/workspace/main.js",
      version: "1.3.2",
      revision: "test-revision",
      onMissing: () => {},
    }),
  ).bun;

  return {
    bun,
    filesystem,
    nodeFs,
    process,
    stdinStream: streams.stdin,
    stdinDataListenersBeforeBun,
    async close() {
      await programHost.processes.dispose();
      streams.stdin.destroy();
      streams.stdout.destroy();
      streams.stderr.destroy();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

function binding(
  registry: KernelProgramRegistry,
  input: {
    readonly name: string;
    readonly version: string;
    readonly abiVersion: number;
    readonly entrypoint: string;
    readonly runInline: KernelInlineProgram;
    readonly requiredCapabilities?: readonly KernelCapability[];
  },
): KernelProgramBinding {
  const requiredCapabilities: readonly KernelCapability[] = input.requiredCapabilities ?? [
    "process.spawn",
  ];
  const manifest = {
    name: input.name,
    version: input.version,
    abiVersion: input.abiVersion,
    requiredCapabilities,
    entrypoint: input.entrypoint,
  };
  const registered = registry.register(manifest);
  if (registered.status !== "ok") {
    const message =
      registered.status === "error" ? registered.error.message : "registry would block";
    throw new Error(`Test registration failed: ${message}`);
  }
  return {
    manifest,
    implementation: { kind: "javascript", runInline: input.runInline },
  };
}

describe("Bun adapter over the shared Node kernel adapters", () => {
  it("shares file bytes and descriptor offsets with Node fs, including POSIX errors", async () => {
    const host = harness();
    const path = "/workspace/data.bin";
    try {
      host.nodeFs.fs.writeFileSync(path, new Uint8Array([0, 255, 16, 128]));
      expect(host.bun.file(path).size).toBe(4);
      expect(await host.bun.file(path).exists()).toBe(true);
      expect(Array.from(await host.bun.file(path).bytes())).toEqual([0, 255, 16, 128]);

      const fd = host.nodeFs.fs.openSync(path, "r+");
      try {
        const prefix = new Uint8Array(1);
        expect(host.nodeFs.fs.readSync(fd, prefix, 0, 1, null)).toBe(1);
        await host.bun.write(fd, new Uint8Array([170]));
        expect(host.bun.file(fd).size).toBe(4);
        expect(await host.bun.file(fd).exists()).toBe(true);
        expect(Array.from(await host.bun.file(fd).bytes())).toEqual([16, 128]);
        expect(host.nodeFs.fs.readSync(fd, new Uint8Array(1), 0, 1, null)).toBe(0);
        const stored = host.nodeFs.fs.readFileSync(path);
        if (typeof stored === "string") throw new Error("Binary read returned text");
        expect(Array.from(stored)).toEqual([0, 170, 16, 128]);
      } finally {
        host.nodeFs.fs.closeSync(fd);
      }

      await host.bun.write(path, new Uint8Array([0, 255, 254]));
      const stored = host.nodeFs.fs.readFileSync(path);
      if (typeof stored === "string") throw new Error("Binary read returned text");
      expect(Array.from(stored)).toEqual([0, 255, 254]);
      await expect(host.bun.file("/workspace/missing").bytes()).rejects.toMatchObject({
        code: "ENOENT",
        syscall: "readFile",
        path: "/workspace/missing",
      });
    } finally {
      await host.close();
    }
  });

  it("searches only registered guest programs and propagates non-missing registry errors", async () => {
    const host = harness();
    try {
      expect(host.bun.which("test-tool")).toBe("/workspace/bin/test-tool");
      expect(host.bun.which("./bin/test-tool")).toBe("/workspace/bin/test-tool");
      expect(host.bun.which("test-tool", { PATH: "bin", cwd: "/workspace/child/.." })).toBe(
        "/workspace/bin/test-tool",
      );

      host.process.env.PATH = undefined;
      expect(host.bun.which("test-tool")).toBeNull();
      expect(host.bun.which("/workspace/bin/test-tool")).toBe("/workspace/bin/test-tool");

      let registryError: unknown;
      try {
        host.bun.which("test-tool", { PATH: "/broken/bin" });
      } catch (error) {
        registryError = error;
      }
      expect(registryError).toEqual(expect.objectContaining({ code: "UNSUPPORTED" }));
    } finally {
      await host.close();
    }
  });

  it("adapts piped subprocess streams and Bun signal exit status", async () => {
    const host = harness();
    let inheritedStderr = "";
    host.process.stderr.on("data", (chunk: Uint8Array) => (inheritedStderr += chunk.toString()));
    try {
      const child = host.bun.spawn(["test-tool", "hello"], {
        cwd: "/workspace",
        env: { PATH: "bin", HOME: "/workspace/home" },
        argv0: "mapped-tool",
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(Number.isSafeInteger(child.pid)).toBe(true);
      if (!child.stdout || !child.stderr) throw new Error("Bun subprocess pipes were not exposed");
      if (!(child.stdin instanceof WritableStream))
        throw new Error("Bun stdin was not exposed as a Web stream");
      const stdinWriter = child.stdin.getWriter();
      await stdinWriter.write(new Uint8Array([0, 255]));
      await stdinWriter.close();
      stdinWriter.releaseLock();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect([stdout, stderr, exitCode]).toEqual(["out:mapped-tool,hello", "err", 17]);
      expect(child.exitCode).toBe(17);

      const signaled = host.bun.spawn(["test-tool"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!signaled.stdout || !signaled.stderr)
        throw new Error("Bun subprocess pipes were not exposed");
      const exited = signaled.exited;
      signaled.kill("SIGTERM");
      await expect(exited).resolves.toBe(143);
      await expect(
        Promise.all([new Response(signaled.stdout).text(), new Response(signaled.stderr).text()]),
      ).resolves.toEqual(["", ""]);
      expect(signaled.exitCode).toBeNull();
      expect(signaled.signalCode).toBe("SIGTERM");
      expect(inheritedStderr).toBe("");
    } finally {
      await host.close();
    }
  });

  it("keeps piped child output available when Bun reads only after exit", async () => {
    const host = harness();
    try {
      const child = host.bun.spawn(["test-tool", "after-exit"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!child.stdout || !child.stderr) throw new Error("Bun subprocess pipes were not exposed");

      await expect(child.exited).resolves.toBe(17);
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect([stdout, stderr, child.exitCode]).toEqual(["out:test-tool,after-exit", "err", 17]);
    } finally {
      await host.close();
    }
  });

  it("matches Bun defaults and routes inherited or ignored stdio through host streams", async () => {
    const host = harness();
    let inheritedStdout = "";
    let inheritedStderr = "";
    host.process.stdout.on("data", (chunk: Uint8Array) => (inheritedStdout += chunk.toString()));
    host.process.stderr.on("data", (chunk: Uint8Array) => (inheritedStderr += chunk.toString()));
    try {
      const defaults = host.bun.spawn(["test-tool", "default"]);
      expect(defaults.stdin).toBeUndefined();
      expect(defaults.stdout).toBeDefined();
      expect(defaults.stderr).toBeUndefined();
      if (!defaults.stdout) throw new Error("Bun default stdout pipe was unavailable");
      const [stdout, exitCode] = await Promise.all([
        new Response(defaults.stdout).text(),
        defaults.exited,
      ]);
      expect([stdout, exitCode, defaults.exitCode, defaults.signalCode]).toEqual([
        "out:test-tool,default",
        17,
        17,
        null,
      ]);
      expect(inheritedStderr).toBe("err");

      const inherited = host.bun.spawn(["test-tool", "inherited"], {
        stdout: "inherit",
        stderr: "ignore",
      });
      expect(inherited.stdout).toBeUndefined();
      expect(inherited.stderr).toBeUndefined();
      expect(await inherited.exited).toBe(17);
      expect(inheritedStdout).toBe("out:test-tool,inherited");
      expect(inheritedStderr).toBe("err");

      await new Promise<void>((resolve, reject) => {
        host.process.stdout.write("parent-after-inherited-child", (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      expect(inheritedStdout).toBe("out:test-tool,inheritedparent-after-inherited-child");

      await new Promise<void>((resolve, reject) => {
        host.process.stderr.write("parent-after-first-child", (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      const secondDefault = host.bun.spawn(["test-tool", "second-default"]);
      if (!secondDefault.stdout) throw new Error("Bun default stdout pipe was unavailable");
      const [secondStdout, secondExit] = await Promise.all([
        new Response(secondDefault.stdout).text(),
        secondDefault.exited,
      ]);
      expect([secondStdout, secondExit]).toEqual(["out:test-tool,second-default", 17]);
      expect(inheritedStderr).toBe("errparent-after-first-childerr");
    } finally {
      await host.close();
    }
  });

  it("leaves process.stdin readable until Bun.stdin is explicitly consumed", async () => {
    const host = harness();
    const payload = new Uint8Array(300 * 1024).fill(97);
    try {
      expect(host.process.stdin.listenerCount("data")).toBe(host.stdinDataListenersBeforeBun);
      host.stdinStream.write(payload);
      const received = host.stdinStream.read() as Uint8Array;
      expect(received.byteLength).toBe(payload.byteLength);
      expect(received.every((byte) => byte === 97)).toBe(true);
    } finally {
      await host.close();
    }

    const bunStdinHost = harness();
    try {
      bunStdinHost.stdinStream.end("bun stdin remains readable");
      await expect(bunStdinHost.bun.stdin.text()).resolves.toBe("bun stdin remains readable");
    } finally {
      await bunStdinHost.close();
    }
  });

  it("unpipes inherited child stdin after close", async () => {
    const host = harness();
    try {
      const listenerCount = host.process.stdin.listenerCount("data");
      const child = host.bun.spawn(["test-tool"], {
        stdin: "inherit",
        stdout: "ignore",
        stderr: "ignore",
      });
      await expect(child.exited).resolves.toBe(17);
      expect(host.process.stdin.listenerCount("data")).toBe(listenerCount);
      expect(host.process.stdin.destroyed).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("throws ENOENT synchronously when Bun.spawn cannot find an executable", async () => {
    const host = harness();
    try {
      let missingError: unknown;
      try {
        host.bun.spawn(["missing-tool"]);
      } catch (error) {
        missingError = error;
      }
      expect(missingError).toMatchObject({
        code: "ENOENT",
        syscall: "spawn",
        path: "missing-tool",
      });
    } finally {
      await host.close();
    }
  });

  it("throws the synchronous kernel admission error when no child PID was assigned", async () => {
    const host = harness({ maxProcesses: 1 });
    let inheritedStderr = "";
    host.process.stderr.on("data", (chunk: Uint8Array) => (inheritedStderr += chunk.toString()));
    try {
      const first = host.bun.spawn(["test-tool"]);
      expect(first.pid).toBeGreaterThan(1);

      let admissionError: unknown;
      try {
        host.bun.spawn(["test-tool"]);
      } catch (error) {
        admissionError = error;
      }
      expect(admissionError).toMatchObject({ code: "EAGAIN", syscall: "spawn" });

      if (!first.stdout) throw new Error("Bun subprocess stdout pipe was not exposed");
      expect(first.stderr).toBeUndefined();
      const [stdout, exitCode] = await Promise.all([
        new Response(first.stdout).text(),
        first.exited,
      ]);
      expect([stdout, inheritedStderr, exitCode]).toEqual(["out:test-tool", "err", 17]);
    } finally {
      await host.close();
    }
  });

  it("rejects unsupported terminal, detached, and binary stdin modes", async () => {
    const host = harness();
    try {
      expect(() => host.bun.spawn(["test-tool"], { stdin: new Uint8Array([1]) })).toThrow(
        BunCapabilityUnavailable,
      );
      expect(() => host.bun.spawn(["test-tool"], { terminal: true })).toThrow(
        BunCapabilityUnavailable,
      );
      expect(() => host.bun.spawn(["test-tool"], { detached: true })).toThrow(
        BunCapabilityUnavailable,
      );
    } finally {
      await host.close();
    }
  });
});
