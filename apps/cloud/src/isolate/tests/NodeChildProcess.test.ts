import { describe, expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";

import {
  ABI_VERSION,
  KernelProgramRegistry,
  kernelError,
  kernelOk,
  type KernelBackend,
  type KernelHandle,
  type KernelResult,
  type KernelOperations,
} from "../../kernel/KernelAbi.ts";
import type {
  KernelExitStatus,
  KernelPipedProgram,
  KernelPreparedProgram,
  KernelProgramHost,
  KernelProgramPrepareInput,
  KernelProgramPrepareOptions,
} from "../../kernel/KernelProgramHost.ts";
import { createNodeChildProcess } from "../NodeChildProcess.ts";

// These adapter tests implement the frozen KernelProgramHost seam. #1064's real-host proof is separate.

interface SpawnRequest {
  readonly program: KernelOperations["process.spawn"]["input"]["program"];
  readonly args: readonly string[];
  readonly env: KernelOperations["process.spawn"]["input"]["env"];
}

function fixture(
  options: {
    readonly immediateExit?: boolean;
    readonly invalidPid?: boolean;
    readonly missingExecutable?: string;
    readonly parentSignal?: AbortSignal;
    readonly preparedCwd?: string;
    readonly spawnFailure?: boolean;
  } = {},
) {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExited!: (result: KernelResult<KernelExitStatus>) => void;
  let spawnRequest: SpawnRequest | undefined;
  let inlineRequest: SpawnRequest | undefined;
  const resolveRequests: string[] = [];
  let prepareInput: KernelProgramPrepareInput | undefined;
  let prepareOptions: KernelProgramPrepareOptions | undefined;
  let syncStdio: KernelProgramPrepareOptions["stdio"] | undefined;
  let syncOutput = new Uint8Array();
  let syncExitCode = 0;
  let syncInput = "";
  let finished = false;
  let released = false;
  let releaseCount = 0;
  let reapCount = 0;
  const signals: number[] = [];
  const exited = new Promise<KernelResult<KernelExitStatus>>((resolve) => {
    resolveExited = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });
  const stdin = new WritableStream<Uint8Array>();
  const handle: KernelHandle<"process"> = { id: "portable-test", kind: "process" };
  const prepared = {
    filesystem: {
      get cwd() {
        return (
          options.preparedCwd ?? (prepareOptions?.cwd as string | undefined) ?? "/work/current"
        );
      },
    },
    parent: undefined,
    signal: undefined,
    home: "/work/home",
    async release() {
      if (!released) {
        released = true;
        releaseCount++;
      }
    },
    releaseSync() {
      if (!released) {
        released = true;
        releaseCount++;
      }
    },
  } as unknown as KernelPreparedProgram;

  function finish(exitCode: number, signal: number) {
    if (finished) return;
    finished = true;
    stdoutController.close();
    stderrController.close();
    resolveExited(kernelOk({ exitCode, signal, coreDumped: false }));
  }

  const registry = new KernelProgramRegistry();
  const registered = new Map<string, { name: string; version: string }>();
  for (const executable of ["/bin/sh", "/bin/bash", "worker", "tool", "echo"]) {
    const manifest = {
      name: executable,
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: ["process.spawn"] as const,
      entrypoint: `${executable}:entry`,
    };
    registry.register(manifest);
    registered.set(executable, manifest);
    if (executable === "tool") registered.set("/work/current/bin/tool", manifest);
  }
  const resolutionBackend: KernelBackend = {
    "process.spawn": () => kernelError("UNSUPPORTED", "Registry resolution only"),
  };

  const host = {
    processes: {
      info() {
        return kernelOk({ pid: options.invalidPid ? 0 : 901, parentPid: 1, processGroupId: 1 });
      },
      signal(_handle: KernelHandle<"process">, signal: number) {
        signals.push(signal);
        if (signal !== 0) finish(0, signal);
        return kernelOk(undefined);
      },
      signalPid(_parent: KernelHandle<"process"> | undefined, _selector: number, signal: number) {
        signals.push(signal);
        if (signal !== 0) finish(0, signal);
        return kernelOk(undefined);
      },
    },
    prepare(input: KernelProgramPrepareInput, options: KernelProgramPrepareOptions = {}) {
      prepareInput = input;
      prepareOptions = options;
      syncStdio = options.stdio;
      return prepared;
    },
    preparePiped(
      input: KernelProgramPrepareInput,
      options: Omit<KernelProgramPrepareOptions, "stdio"> = {},
    ) {
      prepareInput = input;
      prepareOptions = options;
      input.signal?.addEventListener("abort", () => finish(0, 15), { once: true });
      return { prepared, stdin, stdout, stderr } as KernelPipedProgram;
    },
    resolve(executable: string) {
      resolveRequests.push(executable);
      if (executable === options.missingExecutable) {
        return kernelError("NOT_FOUND", "Executable is not registered");
      }
      const manifest = registered.get(executable);
      if (!manifest) return kernelError("NOT_FOUND", "Executable is not registered");
      return registry.resolve(manifest.name, manifest.version, [ABI_VERSION], resolutionBackend);
    },
    backend() {
      const backend: KernelBackend = {
        "process.spawn": ({ program, args, env }) => {
          if (options.spawnFailure)
            return kernelError("RESOURCE_LIMIT", "Process capacity is full");
          spawnRequest = { program, args, env };
          if (options.immediateExit) finish(0, 0);
          return kernelOk(handle);
        },
      };
      return backend;
    },
    exitStatus() {
      return exited;
    },
    reap() {
      reapCount++;
      return kernelOk(undefined);
    },
    runInline(
      _prepared: KernelPreparedProgram,
      program: SpawnRequest["program"],
      args: readonly string[],
      env: Readonly<Record<string, string>>,
    ) {
      inlineRequest = { program, args, env };
      const input = new Uint8Array(64);
      const readResult = syncStdio?.[0]?.readInto?.(input, 0);
      if (readResult !== undefined && typeof readResult !== "number") {
        throw new TypeError("Inline stdio reads must be synchronous");
      }
      const bytesRead = readResult ?? 0;
      syncInput = new TextDecoder().decode(input.subarray(0, bytesRead));
      syncStdio?.[1]?.write?.(syncOutput, 0);
      return syncExitCode;
    },
  } as unknown as KernelProgramHost;

  const filesystem = {
    get cwd() {
      return "/work/current";
    },
    chdir() {},
  } as unknown as KernelProgramPrepareInput["filesystem"];
  const process = {
    filesystem,
    env: { PARENT: "yes" },
    home: "/work/home",
    ...(options.parentSignal === undefined ? {} : { signal: options.parentSignal }),
  };
  const childProcess = createNodeChildProcess(host, process);

  return {
    childProcess,
    get spawnRequest() {
      return spawnRequest;
    },
    get inlineRequest() {
      return inlineRequest;
    },
    resolveRequests,
    get prepareInput() {
      return prepareInput;
    },
    get prepareOptions() {
      return prepareOptions;
    },
    get releaseCount() {
      return releaseCount;
    },
    get reapCount() {
      return reapCount;
    },
    get syncInput() {
      return syncInput;
    },
    signals,
    stdoutController,
    stderrController,
    finish,
    setSyncOutput(output: string, exitCode = 0) {
      syncOutput = new TextEncoder().encode(output);
      syncExitCode = exitCode;
    },
  };
}

function waitFor(
  emitter: { once: (event: string, listener: (...args: unknown[]) => void) => unknown },
  event: string,
) {
  return new Promise<unknown[]>((resolve) => emitter.once(event, (...args) => resolve(args)));
}

describe("Node child_process adapter", () => {
  it("runs shell commands through registered /bin/sh and closes after output drains", async () => {
    const host = fixture();
    const events: string[] = [];
    const command = "printf 'hello world'";
    const child = host.childProcess.exec(command, { encoding: "utf8" }, (error, stdout) => {
      expect(error).toBeNull();
      expect(stdout).toBe("hello world");
    });
    const stdout = child.stdout;
    if (!stdout) throw new Error("exec should capture stdout by default");
    stdout.on("data", () => events.push("data"));
    child.on("spawn", () => events.push("spawn"));
    child.on("exit", () => events.push("exit"));
    const closed = new Promise<void>((resolve) => {
      child.on("close", () => {
        events.push("close");
        resolve();
      });
    });

    await waitFor(child, "spawn");
    expect(host.spawnRequest).toMatchObject({
      program: { name: "/bin/sh" },
      args: ["/bin/sh", "-c", command],
      env: { PARENT: "yes" },
    });
    expect(host.prepareOptions).toEqual({ cwd: "/work/current" });
    expect(host.prepareInput).toMatchObject({ home: "/work/home" });
    host.stdoutController.enqueue(new TextEncoder().encode("hello world"));
    host.finish(0, 0);
    await closed;

    expect(events[0]).toBe("spawn");
    expect(events.indexOf("data")).toBeLessThan(events.indexOf("close"));
    expect(events.indexOf("exit")).toBeLessThan(events.indexOf("close"));
    expect(host.releaseCount).toBe(1);
    expect(host.reapCount).toBe(1);
  });

  it("publishes PID synchronously and emits spawn before an immediate exit", async () => {
    const host = fixture({ immediateExit: true });
    const child = host.childProcess.spawn("worker");
    expect(child.pid).toBe(901);

    const events: string[] = [];
    child.once("spawn", () =>
      events.push(child.pid === 901 ? "spawn-with-pid" : "spawn-without-pid"),
    );
    child.once("exit", () => events.push("exit"));
    child.once("close", () => events.push("close"));
    expect(events).toEqual([]);

    await waitFor(child, "close");
    expect(events).toEqual(["spawn-with-pid", "exit", "close"]);
  });

  it("resolves async and sync PATH commands against guest cwd while keeping argv0", async () => {
    const host = fixture({ preparedCwd: "/work/canonical" });
    const child = host.childProcess.spawn("tool", ["async"], {
      cwd: "/work/current/nested",
      env: { PATH: "../bin" },
      argv0: "async-tool",
    });
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    expect(host.resolveRequests).toContain("/work/current/bin/tool");
    expect(child.spawnfile).toBe("tool");
    expect(host.spawnRequest).toMatchObject({
      args: ["async-tool", "async"],
      env: { PATH: "../bin" },
    });
    expect(host.prepareOptions).toMatchObject({ cwd: "/work/current/nested" });
    host.finish(0, 0);
    await closed;

    const sync = host.childProcess.spawnSync("tool", ["sync"], {
      cwd: "/work/current/nested",
      env: { PATH: "../bin" },
      argv0: "sync-tool",
    });
    expect(sync.status).toBe(0);
    expect(host.resolveRequests.at(-1)).toBe("/work/current/bin/tool");
    expect(host.inlineRequest).toMatchObject({
      args: ["sync-tool", "sync"],
      env: { PATH: "../bin" },
    });
    expect(host.prepareOptions).toMatchObject({ cwd: "/work/current/nested" });
  });

  it("preserves explicit empty and stale-PWD environments for ordinary programs", async () => {
    for (const env of [Object.freeze({}), Object.freeze({ PWD: "/stale", KEEP: "yes" })]) {
      const host = fixture({ preparedCwd: "/work/canonical" });
      const child = host.childProcess.spawn("worker", [], { env });
      const closed = waitFor(child, "close");
      await waitFor(child, "spawn");
      expect(host.spawnRequest?.env).toEqual(env);
      host.finish(0, 0);
      await closed;

      const result = host.childProcess.spawnSync("worker", [], { env });
      expect(result.status).toBe(0);
      expect(host.inlineRequest?.env).toEqual(env);
    }
  });

  it("keeps close after public stdout ends during async iteration", async () => {
    const host = fixture();
    const child = host.childProcess.spawn("worker");
    const events: string[] = [];
    child.stdout.once("end", () => events.push("stdout-end"));
    child.once("exit", () => events.push("exit"));
    child.once("close", () => events.push("close"));
    const stdout = (async () => {
      let result = "";
      for await (const chunk of child.stdout) result += chunk.toString();
      return result;
    })();
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    host.stdoutController.enqueue(new TextEncoder().encode("tail"));
    host.finish(0, 0);
    expect(await stdout).toBe("tail");
    await closed;

    expect(events.indexOf("exit")).toBeLessThan(events.indexOf("stdout-end"));
    expect(events.indexOf("stdout-end")).toBeLessThan(events.indexOf("close"));
    expect(host.reapCount).toBe(1);
  });

  it("resumes unconsumed stdout after exit so a full public pipe cannot hold reaping", async () => {
    const host = fixture();
    const child = host.childProcess.spawn("worker");
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    host.stdoutController.enqueue(new Uint8Array(256 * 1024));
    host.finish(0, 0);
    await closed;

    expect(host.reapCount).toBe(1);
  });

  it("signals a child abort with killSignal and drains output through exit and close", async () => {
    const host = fixture();
    const controller = new AbortController();
    const child = host.childProcess.spawn("worker", {
      signal: controller.signal,
      killSignal: "SIGINT",
    });
    const events: string[] = [];
    let stdout = "";
    child.stdout.on("data", (chunk: Uint8Array) => (stdout += chunk.toString()));
    child.on("error", (error: Error) => events.push(`error:${error.name}`));
    child.on("exit", (code, signal) => events.push(`exit:${String(code)}:${String(signal)}`));
    child.on("close", (code, signal) => events.push(`close:${String(code)}:${String(signal)}`));
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    host.stdoutController.enqueue(new TextEncoder().encode("before-signal"));
    controller.abort();
    await closed;

    expect(host.signals).toEqual([2]);
    expect(host.prepareInput?.signal?.aborted).toBe(false);
    expect(stdout).toBe("before-signal");
    expect(events).toEqual(["error:AbortError", "exit:null:SIGINT", "close:null:SIGINT"]);
    expect(host.reapCount).toBe(1);
  });

  it("keeps parent cancellation on the prepared host context", async () => {
    const controller = new AbortController();
    const host = fixture({ parentSignal: controller.signal });
    const child = host.childProcess.spawn("worker");
    const events: string[] = [];
    child.on("exit", (code, signal) => events.push(`exit:${String(code)}:${String(signal)}`));
    child.on("close", (code, signal) => events.push(`close:${String(code)}:${String(signal)}`));
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    controller.abort();
    await closed;

    expect(host.prepareInput?.signal?.aborted).toBe(true);
    expect(host.signals).toEqual([]);
    expect(child.killed).toBe(false);
    expect(events).toEqual(["exit:null:SIGTERM", "close:null:SIGTERM"]);
  });

  it("rejects a kernel spawn without a valid immediate PID and suppresses spawn and exit", async () => {
    const host = fixture({ invalidPid: true });
    const child = host.childProcess.spawn("worker");
    expect(child.pid).toBeUndefined();

    const events: string[] = [];
    const error = waitFor(child, "error").then((args) => {
      events.push("error");
      return args;
    });
    child.once("spawn", () => events.push("spawn"));
    child.once("exit", () => events.push("exit"));
    child.once("close", () => events.push("close"));
    const closed = waitFor(child, "close");

    await expect(error).resolves.toMatchObject([
      expect.objectContaining({ code: "EIO", syscall: "spawn" }),
    ]);
    await closed;
    expect(events).toEqual(["error", "close"]);
    expect(host.signals).toEqual([15]);
    expect(host.reapCount).toBe(1);
  });

  it("passes shell:true commands as a joined string with shell metacharacters intact", async () => {
    const host = fixture();
    const child = host.childProcess.spawn("echo a | tr a b", { shell: true, argv0: "sh-custom" });
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    expect(host.spawnRequest).toMatchObject({
      program: { name: "/bin/sh" },
      args: ["sh-custom", "-c", "echo a | tr a b"],
    });
    host.finish(0, 0);
    await closed;
  });

  it("uses the exact registered bash executable for shell options and keeps argv0", async () => {
    const spawned = fixture();
    const child = spawned.childProcess.spawn("echo", ["two words", "it's"], {
      shell: "/bin/bash",
      argv0: "bash-spawn",
    });
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    expect(spawned.spawnRequest).toMatchObject({
      program: { name: "/bin/bash" },
      args: ["bash-spawn", "-c", "echo two words it's"],
    });
    expect(child.spawnfile).toBe("/bin/bash");
    spawned.finish(0, 0);
    await closed;

    const executed = fixture();
    const command = "printf '%s' 'two words'";
    const callback = new Promise<unknown[]>((resolve) => {
      const shellChild = executed.childProcess.exec(
        command,
        { encoding: "utf8", shell: "/bin/bash", argv0: "bash-exec" },
        (...args) => resolve(args),
      );
      void waitFor(shellChild, "spawn").then(() => {
        executed.stdoutController.enqueue(new TextEncoder().encode("two words"));
        executed.finish(0, 0);
      });
    });
    await expect(callback).resolves.toEqual([null, "two words", ""]);
    expect(executed.spawnRequest).toMatchObject({
      program: { name: "/bin/bash" },
      args: ["bash-exec", "-c", command],
    });

    const synchronous = fixture();
    synchronous.setSyncOutput("sync output");
    expect(
      synchronous.childProcess.execSync("printf '%s' 'sync output'", {
        encoding: "utf8",
        shell: "/bin/bash",
        argv0: "bash-sync",
      }),
    ).toBe("sync output");
    expect(synchronous.inlineRequest).toMatchObject({
      program: { name: "/bin/bash" },
      args: ["bash-sync", "-c", "printf '%s' 'sync output'"],
      env: { PARENT: "yes" },
    });
  });

  it("maps a host signal and exit signal back to Node child events", async () => {
    const host = fixture();
    const child = host.childProcess.spawn("worker");
    const exit = waitFor(child, "exit");
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    expect(child.pid).toBe(901);
    expect(child.kill("SIGTERM")).toBe(true);
    expect(host.signals).toEqual([15]);
    await expect(exit).resolves.toEqual([null, "SIGTERM"]);
    await closed;
  });

  it("allows an error listener to attach when the supplied signal is already aborted", async () => {
    const host = fixture();
    const controller = new AbortController();
    controller.abort();
    const child = host.childProcess.spawn("worker", { signal: controller.signal });
    const error = waitFor(child, "error");
    const closed = waitFor(child, "close");

    await expect(error).resolves.toMatchObject([
      expect.objectContaining({ name: "AbortError", code: "ABORT_ERR" }),
    ]);
    await closed;
    expect(host.prepareInput).toBeUndefined();
  });

  it("stops at maxBuffer bytes, returns truncated output and preserves the callback error", async () => {
    const host = fixture();
    let child!: ReturnType<typeof host.childProcess.spawn>;
    const callback = new Promise<unknown[]>((resolve) => {
      child = host.childProcess.execFile(
        "tool",
        [],
        { encoding: "utf8", maxBuffer: 3 },
        (...args) => resolve(args),
      );
    });
    await waitFor(child, "spawn");
    const closed = waitFor(child, "close");
    host.stdoutController.enqueue(new TextEncoder().encode("toolong"));

    const [error, stdout] = await callback;
    expect(error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    expect(stdout).toBe("too");
    expect(host.signals).toEqual([15]);
    await closed;
  });

  it("bounds and drains execFile output without a callback, then reaps the process", async () => {
    const host = fixture();
    const child = host.childProcess.execFile("tool", [], { maxBuffer: 4 });
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    host.stdoutController.enqueue(new Uint8Array(256 * 1024));
    await closed;

    expect(host.signals).toEqual([15]);
    expect(child.killed).toBe(true);
    expect(host.reapCount).toBe(1);
  });

  it("bounds callback-free exec output with its configured kill signal, then reaps", async () => {
    const host = fixture();
    const child = host.childProcess.exec("command", { maxBuffer: 4, killSignal: "SIGKILL" });
    const closed = waitFor(child, "close");
    await waitFor(child, "spawn");

    host.stdoutController.enqueue(new Uint8Array(256 * 1024));
    await closed;

    expect(host.signals).toEqual([9]);
    expect(child.killed).toBe(true);
    expect(host.reapCount).toBe(1);
  });

  it("turns a missing registered executable into error then close without a fake pid", async () => {
    const host = fixture({ missingExecutable: "missing" });
    const child = host.childProcess.spawn("missing");
    const error = waitFor(child, "error");
    const closed = waitFor(child, "close");

    await expect(error).resolves.toMatchObject([expect.objectContaining({ code: "ENOENT" })]);
    await closed;
    expect(child.pid).toBeUndefined();
    expect(host.reapCount).toBe(0);
    expect(host.prepareInput).toBeUndefined();
    expect(host.releaseCount).toBe(0);
  });

  it("releases prepared pipes before closing a rejected process admission", async () => {
    const host = fixture({ spawnFailure: true });
    const events: string[] = [];
    const returned = { value: false };
    const child = host.childProcess.spawn("worker");
    const error = waitFor(child, "error").then((args) => {
      expect(returned.value).toBe(true);
      events.push("error");
      return args;
    });
    child.on("close", () => events.push("close"));
    const closed = waitFor(child, "close");
    returned.value = true;

    await expect(error).resolves.toMatchObject([expect.objectContaining({ code: "EAGAIN" })]);
    await closed;

    expect(events).toEqual(["error", "close"]);
    expect(child.pid).toBeUndefined();
    expect(host.releaseCount).toBe(1);
    expect(host.reapCount).toBe(0);
  });

  it("runs synchronous registered programs with bounded output and piped input", () => {
    const host = fixture();
    host.setSyncOutput("inline");
    const result = host.childProcess.spawnSync("tool", [], { input: "request" });

    expect(result).toMatchObject({
      pid: undefined,
      stdout: NodeBuffer.Buffer.from("inline"),
      stderr: NodeBuffer.Buffer.alloc(0),
      status: 0,
      signal: null,
    });
    expect(host.syncInput).toBe("request");
    expect(host.releaseCount).toBe(1);
  });

  it("keeps sync exec output as bytes by default and throws on non-zero execFileSync", () => {
    const host = fixture();
    host.setSyncOutput("inline");
    expect(host.childProcess.execSync("command")).toEqual(NodeBuffer.Buffer.from("inline"));

    host.setSyncOutput("failed", 2);
    expect(() => host.childProcess.execFileSync("tool")).toThrow(
      expect.objectContaining({ status: 2, stdout: NodeBuffer.Buffer.from("failed") }),
    );
  });

  it("rejects invalid callbacks before starting a child", () => {
    const host = fixture();
    const invalidCallback = "not-a-callback" as unknown as (...args: unknown[]) => void;

    expect(() => host.childProcess.exec("command", {}, invalidCallback as never)).toThrow(
      /callback.*function/,
    );
    expect(() =>
      host.childProcess.exec("command", (() => {}) as never, (() => {}) as never),
    ).toThrow(/Too many arguments/);
    expect(() => host.childProcess.execFile("tool", [], {}, invalidCallback as never)).toThrow(
      /callback.*function/,
    );
    expect(host.prepareInput).toBeUndefined();
  });

  it("returns explicit ENOTSUP for sync timeout and throws it through execSync", () => {
    const host = fixture();
    const result = host.childProcess.spawnSync("tool", { timeout: 1 });
    expect(result.error).toMatchObject({ code: "ENOTSUP" });
    expect(() => host.childProcess.execSync("command", { timeout: 1 })).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
  });

  it("keeps IPC, PTY and non-pipe stdio paths explicitly unsupported", () => {
    const host = fixture();
    expect(() => host.childProcess.fork("worker.js")).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
    expect(() => host.childProcess.spawn("worker", { stdio: "inherit" })).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
    expect(() => host.childProcess.spawn("worker", { agentosPty: true })).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
  });
});
