// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "@effect/vitest";
import type { ComputerExecPort } from "../../computer/Computer.ts";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  kernelOk,
  kernelError,
} from "../../kernel/KernelAbi.ts";
import type { KernelCommandChild, KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";
import { KernelCommandExecutor } from "../../kernel/KernelCommandExecutor.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { createNodeBunHost } from "../NodeBun.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";
import type { NodeChildProcess } from "../NodeChildProcess.ts";
import { createNodeFs } from "../NodeFs.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(computer: ComputerExecPort, maxProcesses?: number) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  filesystem.mkdir("/work");
  filesystem.mkdir("/work/sub");
  filesystem.chdir("/work");
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "hook",
    version: "1",
    abiVersion: ABI_VERSION,
    entrypoint: "hook",
    requiredCapabilities: ["process.spawn"] as const,
  };
  registry.register(manifest);
  const host = new KernelProgramHost({
    registry,
    wakes,
    processes: new KernelProcessTable({
      wakes,
      ...(maxProcesses === undefined ? {} : { maxProcesses }),
    }),
    programs: new Map([
      [
        "/bin/hook",
        {
          manifest,
          implementation: {
            kind: "javascript",
            runInline: ({ filesystem: child }) => {
              child.write(1, new Uint8Array([0, 255, 128]), null);
              return 7;
            },
          },
        },
      ],
    ]),
  });
  const context = { filesystem, env: { PATH: "/bin", HOME: "/work/home" }, home: "/work/home" };
  const childProcess = createNodeComputerChildProcess(host, context, computer);
  const fs = createNodeFs(filesystem).fs;
  return {
    host,
    context,
    childProcess,
    fs,
    filesystem,
    wakes,
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      database.close();
      wakes.dispose();
    },
  };
}

function closed(child: NodeChildProcess) {
  return new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function bytes(stream: NodeJS.ReadableStream) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks);
}

function echoChild(): KernelCommandChild {
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const exited = (async () => {
    const reader = input.readable.getReader();
    const writer = output.writable.getWriter();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await writer.write(next.value);
      }
      await writer.close();
      return { exitCode: 23, signal: 0, coreDumped: false };
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  })();
  return {
    stdin: input.writable,
    stdout: output.readable,
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([254, 0, 129]));
        c.close();
      },
    }),
    exited,
    signal: async () => kernelOk(undefined),
    dispose: async () => {
      await exited;
    },
  };
}

function controlledChild(disposeGate = Promise.resolve()) {
  const exit = deferred<KernelCommandExit>();
  const disposing = deferred<void>();
  const signal = vi.fn(async (number: number) => {
    exit.resolve({ exitCode: 0, signal: number, coreDumped: false });
    return kernelOk(undefined);
  });
  const dispose = vi.fn(async () => {
    disposing.resolve();
    exit.resolve({ exitCode: 0, signal: 9, coreDumped: false });
    await disposeGate;
  });
  const child: KernelCommandChild = {
    stdin: new WritableStream(),
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    exited: exit.promise,
    signal,
    dispose,
  };
  return { child, signal, dispose, disposing };
}

describe("Node child_process through Computer", () => {
  it("admits a real PID synchronously and preserves binary I/O and the complete command", async () => {
    const exec = vi.fn<ComputerExecPort["exec"]>(async () => echoChild());
    const h = harness({ exec });
    const payload = Uint8Array.from({ length: 200_003 }, (_, i) => i % 256);
    try {
      const child = h.childProcess.spawn("external-tool", ["a b", ""], {
        argv0: "custom-zero",
        cwd: "sub",
        env: { ONLY: "exact", NUMBER: 4, OMIT: undefined },
      });
      const order: string[] = [];
      child.on("spawn", () => order.push("spawn"));
      child.on("exit", () => order.push("exit"));
      child.on("close", () => order.push("close"));
      expect(child.pid).toBeGreaterThan(1);
      expect(h.host.processes.lookupPid(child.pid!)).toMatchObject({
        status: "ok",
        value: { info: { pid: child.pid } },
      });
      const stdout = bytes(child.stdout);
      const stderr = bytes(child.stderr);
      const done = closed(child);
      child.stdin.end(payload);
      await done;
      expect(await stdout).toEqual(Buffer.from(payload));
      expect(await stderr).toEqual(Buffer.from([254, 0, 129]));
      expect(exec).toHaveBeenCalledExactlyOnceWith(
        {
          executable: "external-tool",
          argv: ["custom-zero", "a b", ""],
          cwd: "/work/sub",
          env: { ONLY: "exact", NUMBER: "4" },
        },
        expect.any(AbortSignal),
        { processes: h.host.processes, process: expect.objectContaining({ kind: "process" }) },
      );
      expect(child.exitCode).toBe(23);
      expect(order).toEqual(["spawn", "exit", "close"]);
      expect(h.host.processes.size).toBe(0);
      expect(h.wakes.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("routes a registered hook through Computer exactly once", async () => {
    let executor!: KernelCommandExecutor;
    const exec = vi.fn<ComputerExecPort["exec"]>((command, signal) =>
      executor.spawn(command, signal),
    );
    const h = harness({ exec });
    executor = new KernelCommandExecutor({
      host: h.host,
      filesystem: h.filesystem,
      forwarder: {
        spawn: async () => {
          throw new Error("Unexpected fallback");
        },
      },
    });
    try {
      const result = await new Promise<{ error: Error | null; stdout: Uint8Array }>((resolve) => {
        h.childProcess.execFile("/bin/hook", { encoding: "buffer" }, (error, stdout) => {
          resolve({ error, stdout: Buffer.from(stdout) });
        });
      });
      expect(result.error).toMatchObject({ code: 7 });
      expect(result.stdout).toEqual(Buffer.from([0, 255, 128]));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(h.host.processes.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  it.each(["kill", "abort"] as const)(
    "waits for a late child disposal after pending exec %s",
    async (mode) => {
      const pending = deferred<KernelCommandChild>();
      const disposeGate = deferred<void>();
      const remote = controlledChild(disposeGate.promise);
      const exec = vi.fn<ComputerExecPort["exec"]>(() => pending.promise);
      const h = harness({ exec });
      const signal = new AbortController();
      try {
        const child = h.childProcess.spawn("slow-admission", { signal: signal.signal });
        const events: string[] = [];
        child.on("error", (error) => events.push(error.code));
        child.on("exit", () => events.push("exit"));
        child.on("close", () => events.push("close"));
        const done = closed(child);
        if (mode === "kill") expect(child.kill("SIGKILL")).toBe(true);
        else signal.abort();
        expect(exec.mock.calls[0]?.[1].aborted).toBe(true);
        expect(events).not.toContain("close");
        pending.resolve(remote.child);
        await remote.disposing.promise;
        expect(events).not.toContain("exit");
        expect(h.host.processes.size).toBe(1);
        disposeGate.resolve();
        await done;
        expect(remote.dispose).toHaveBeenCalledTimes(1);
        expect(child.signalCode).toBe(mode === "kill" ? "SIGKILL" : "SIGTERM");
        expect(events).toEqual(
          mode === "kill" ? ["exit", "close"] : ["ABORT_ERR", "exit", "close"],
        );
        expect(h.host.processes.size).toBe(0);
        expect(h.wakes.size).toBe(0);
      } finally {
        disposeGate.resolve();
        await h.close();
      }
    },
  );

  it("keeps numeric output descriptors caller-owned, including after the parent closes its alias", async () => {
    const exec = vi.fn<ComputerExecPort["exec"]>(async () => echoChild());
    const h = harness({ exec });
    const fd = h.fs.openSync("/work/out", "w+");
    try {
      const child = h.childProcess.spawn("echo", { stdio: ["pipe", fd, "ignore"] });
      const done = closed(child);
      child.stdin!.end(new Uint8Array([0, 255, 128]));
      await done;
      h.fs.writeSync(fd, new Uint8Array([7]));
      expect(h.fs.readFileSync("/work/out")).toEqual(Buffer.from([0, 255, 128, 7]));
      const second = h.childProcess.spawn("echo", { stdio: ["pipe", fd, "ignore"] });
      const secondDone = closed(second);
      h.fs.closeSync(fd);
      second.stdin!.end(new Uint8Array([8]));
      await secondDone;
      expect(h.fs.readFileSync("/work/out")).toEqual(Buffer.from([0, 255, 128, 7, 8]));
    } finally {
      if (h.filesystem.descriptors.has(fd)) h.fs.closeSync(fd);
      await h.close();
    }
  });

  it("kills an active child and awaits its cleanup before close", async () => {
    const gate = deferred<void>();
    const remote = controlledChild(gate.promise);
    const h = harness({ exec: async () => remote.child });
    try {
      const child = h.childProcess.spawn("running");
      const done = closed(child);
      await new Promise<void>((resolve) => child.once("spawn", resolve));
      expect(child.kill()).toBe(true);
      await remote.disposing.promise;
      expect(h.host.processes.size).toBe(1);
      gate.resolve();
      await done;
      expect(remote.signal).toHaveBeenCalledExactlyOnceWith(15);
      expect(remote.dispose).toHaveBeenCalledTimes(1);
      expect(h.host.processes.size).toBe(0);
      expect(h.wakes.size).toBe(0);
    } finally {
      gate.resolve();
      await h.close();
    }
  });

  it("retains the prepared descriptors until a started output write settles after kill", async () => {
    const writeGate = deferred<number>();
    const writing = deferred<void>();
    const remote = controlledChild();
    const h = harness({
      exec: async () => ({
        ...remote.child,
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([255, 0, 128]));
          },
        }),
      }),
    });
    const prepare = h.host.preparePiped.bind(h.host);
    let childFilesystem: KernelFileSystem | undefined;
    vi.spyOn(h.host, "preparePiped").mockImplementation((...args) => {
      const piped = prepare(...args);
      childFilesystem = piped.prepared.filesystem;
      const stream = childFilesystem.descriptors.get(1).stdio;
      if (!stream) throw new Error("Missing child stdout");
      stream.write = () => {
        writing.resolve();
        return writeGate.promise;
      };
      return piped;
    });
    try {
      const child = h.childProcess.spawn("blocked-write");
      const done = closed(child);
      await writing.promise;
      expect(child.kill("SIGKILL")).toBe(true);
      await remote.child.exited;
      expect(remote.dispose).not.toHaveBeenCalled();
      expect(h.host.processes.size).toBe(1);
      expect(childFilesystem?.descriptors.has(1)).toBe(true);
      writeGate.resolve(3);
      await done;
      expect(childFilesystem?.descriptors.has(1)).toBe(false);
      expect(h.host.processes.size).toBe(0);
      expect(h.wakes.size).toBe(0);
    } finally {
      writeGate.resolve(3);
      await h.close();
    }
  });

  it("reports a rejected asynchronous signal and still disposes the child", async () => {
    const remote = controlledChild();
    const signal = vi.fn(async () => kernelError("PERMISSION_DENIED", "Remote signal rejected"));
    const h = harness({ exec: async () => ({ ...remote.child, signal }) });
    try {
      const child = h.childProcess.spawn("signal-failure");
      const failure = new Promise<Error>((resolve) => child.once("error", resolve));
      const done = closed(child);
      await new Promise<void>((resolve) => child.once("spawn", resolve));
      expect(child.kill()).toBe(true);
      await done;
      expect(await failure).toMatchObject({ code: "EPERM" });
      expect(remote.dispose).toHaveBeenCalledTimes(1);
      expect(child.exitCode).toBeNull();
      expect(h.host.processes.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("installs into the Bun host with a synchronously available kernel PID", async () => {
    const exec = vi.fn<ComputerExecPort["exec"]>(async () => echoChild());
    const h = harness({ exec });
    const streams = {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    };
    try {
      const bun = createNodeBunHost({
        childProcess: h.childProcess,
        programHost: h.host,
        filesystem: createNodeFs(h.filesystem),
        process: { env: h.context.env, cwd: () => h.filesystem.cwd, ...streams },
        main: "/main.js",
        version: "1.3.2",
        revision: "test",
        onMissing: () => {},
      });
      if (!bun.spawn) throw new Error("Missing Bun spawn");
      const child = bun.spawn(["hook"], { stdin: "pipe", stderr: "pipe" });
      const received = new Response(child.stdout).arrayBuffer();
      const errors = new Response(child.stderr).arrayBuffer();
      if (!(child.stdin instanceof WritableStream)) throw new Error("Expected Bun stdin stream");
      const writer = child.stdin.getWriter();
      await writer.write(new Uint8Array([255, 0, 129]));
      await writer.close();
      expect(child.pid).toBeGreaterThan(1);
      expect(await child.exited).toBe(23);
      expect(new Uint8Array(await received)).toEqual(new Uint8Array([255, 0, 129]));
      expect(new Uint8Array(await errors)).toEqual(new Uint8Array([254, 0, 129]));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(h.host.processes.size).toBe(0);
    } finally {
      for (const stream of Object.values(streams)) stream.destroy();
      await h.close();
    }
  });

  it("keeps an exec rejection observable without an invented exit status", async () => {
    const error = Object.assign(new Error("No such executable"), { code: "ENOENT" });
    const exec = vi.fn<ComputerExecPort["exec"]>(async () => {
      throw error;
    });
    const h = harness({ exec });
    try {
      const child = h.childProcess.spawn("missing");
      const observed = new Promise<Error>((resolve) => child.once("error", resolve));
      const done = closed(child);
      const exit = vi.fn();
      child.on("exit", exit);
      await done;
      expect(await observed).toBe(error);
      expect(exit).not.toHaveBeenCalled();
      expect(child.exitCode).toBeNull();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(h.host.processes.size).toBe(0);
      expect(h.wakes.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("does not call Computer when process-table admission rejects the child", async () => {
    const pending = deferred<KernelCommandChild>();
    const remote = controlledChild();
    const exec = vi.fn<ComputerExecPort["exec"]>(() => pending.promise);
    const h = harness({ exec }, 1);
    try {
      const first = h.childProcess.spawn("first");
      first.on("error", () => {});
      const firstDone = closed(first);
      const second = h.childProcess.spawn("second");
      const failure = new Promise<Error>((resolve) => second.once("error", resolve));
      const secondDone = closed(second);
      await secondDone;
      expect(await failure).toMatchObject({ code: "EAGAIN" });
      expect(second.pid).toBeUndefined();
      expect(exec).toHaveBeenCalledTimes(1);
      first.kill("SIGKILL");
      pending.resolve(remote.child);
      await firstDone;
      expect(h.host.processes.size).toBe(0);
    } finally {
      pending.resolve(remote.child);
      await h.close();
    }
  });

  it("inherits a procfd output alias without consuming the caller's descriptors", async () => {
    const h = harness({ exec: async () => echoChild() });
    const fd = h.fs.openSync("/work/procfd", "w+");
    const alias = h.fs.openSync(`/proc/self/fd/${fd}`, "w");
    h.filesystem.descriptors.put(1, h.filesystem.descriptors.take(alias));
    try {
      const child = h.childProcess.spawn("echo", { stdio: ["pipe", "inherit", "ignore"] });
      const done = closed(child);
      child.stdin!.end(new Uint8Array([255, 0, 129]));
      await done;
      h.fs.writeSync(1, new Uint8Array([8]));
      expect(h.fs.readFileSync("/work/procfd")).toEqual(Buffer.from([255, 0, 129, 8]));
      expect(h.fs.fstatSync(fd).isFile()).toBe(true);
      expect(h.fs.fstatSync(1).isFile()).toBe(true);
    } finally {
      h.fs.closeSync(1);
      h.fs.closeSync(fd);
      await h.close();
    }
  });

  it("rejects sync execution explicitly without calling Computer", async () => {
    const exec = vi.fn<ComputerExecPort["exec"]>(async () => echoChild());
    const h = harness({ exec });
    try {
      for (const run of [
        () => h.childProcess.spawnSync("tool"),
        () => h.childProcess.execSync("tool"),
        () => h.childProcess.execFileSync("tool"),
      ])
        expect(run).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
      expect(exec).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
