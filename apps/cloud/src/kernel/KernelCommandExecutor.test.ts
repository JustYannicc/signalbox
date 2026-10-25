import { describe, expect, it, vi } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  kernelError,
  kernelOk,
  type KernelBackend,
  type KernelHandle,
  type KernelResult,
  type RegisteredProgram,
  type ResolvedProgram,
} from "./KernelAbi.ts";
import {
  KernelCommandExecutor,
  type KernelCommandExecutorOptions,
} from "./KernelCommandExecutor.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "./KernelCommandForwarder.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import type { KernelProcessInfo } from "./KernelProcessTable.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const command: KernelCommand = {
  executable: "/bin/tool",
  argv: ["tool-as-argv0", "", "two words"],
  cwd: "file:///workspace/a%20b",
  env: { TOKEN: "exact", EMPTY: "" },
};

const manifest: RegisteredProgram = {
  name: "test-tool",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: ["process.spawn"],
  entrypoint: "test-tool-1.0.0",
};

const handle: KernelHandle<"process"> = { id: "local-child", kind: "process" };
const exitStatus = { exitCode: 7, signal: 0, coreDumped: false };
const stdinBytes = new Uint8Array([99, 0, 255]);
const stdoutBytes = new Uint8Array([0, 65, 255]);
const stderrBytes = new Uint8Array([10, 13]);

describe("KernelCommandExecutor", () => {
  it("runs a registered command with the same argv, cwd, env and byte streams as forwarding", async () => {
    const local = makeHost();
    const forwarded = makeChild(exitStatus, stdoutBytes, stderrBytes);
    const forwarder: KernelCommandForwarder = { spawn: vi.fn(async () => forwarded.child) };
    const forwardedHost = makeHost({
      resolve: () => kernelError("NOT_FOUND", "unknown executable"),
    });
    const executor = new KernelCommandExecutor(
      options(local.host, forwarder, { home: "/home/guest" }),
    );
    const forwardedExecutor = new KernelCommandExecutor(options(forwardedHost.host, forwarder));
    const signal = new AbortController().signal;

    const child = await executor.spawn(command, signal);
    const forwardedChild = await forwardedExecutor.spawn(command, signal);
    expect(local.reap).not.toHaveBeenCalled();
    const localInput = child.stdin.getWriter();
    await localInput.write(stdinBytes);
    await localInput.close();
    const forwardedInput = forwardedChild.stdin.getWriter();
    await forwardedInput.write(stdinBytes);
    await forwardedInput.close();
    const [localStdout, localStderr, localExit] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ]);

    const forwardedStdout = await readAll(forwardedChild.stdout);
    const forwardedStderr = await readAll(forwardedChild.stderr);
    const forwardedExit = await forwardedChild.exited;
    const spawnInput = local.spawnInput!;

    expect(spawnInput).toMatchObject({ args: command.argv, env: command.env });
    expect(local.prepareOptions).toEqual({ cwd: command.cwd });
    expect(local.prepareInput).toMatchObject({ filesystem: local.filesystem });
    expect(local.prepareInput).not.toHaveProperty("home");
    expect(forwarder.spawn).toHaveBeenCalledWith(command, signal);
    expect(forwarder.spawn).toHaveBeenCalledTimes(1);
    expect(local.prepareInput).toMatchObject({ signal });
    expect(localStdout).toEqual(forwardedStdout);
    expect(localStderr).toEqual(forwardedStderr);
    expect(localExit).toEqual(forwardedExit);
    expect(localStdout).toEqual([...stdoutBytes]);
    expect(localStderr).toEqual([...stderrBytes]);
    expect(local.stdinBytes).toEqual(forwarded.stdinBytes);
    expect(local.stdinBytes).toEqual([stdinBytes]);
    expect(local.reap).toHaveBeenCalledTimes(1);
    await child.dispose();
    await forwardedChild.dispose();
  });

  it("forwards only NOT_FOUND and keeps local resolution failures local", async () => {
    const missing = makeHost({ resolve: () => kernelError("NOT_FOUND", "unknown executable") });
    const forwarded = makeChild(exitStatus, stdoutBytes, stderrBytes);
    const forwarder: KernelCommandForwarder = { spawn: vi.fn(async () => forwarded.child) };
    const executor = new KernelCommandExecutor(options(missing.host, forwarder));

    await expect(executor.spawn(command, new AbortController().signal)).resolves.toBe(
      forwarded.child,
    );
    expect(forwarder.spawn).toHaveBeenCalledWith(command, expect.any(AbortSignal));
    expect(missing.preparePiped).not.toHaveBeenCalled();

    const broken = makeHost({ resolve: () => kernelError("PERMISSION_DENIED", "blocked") });
    const blockedForwarder: KernelCommandForwarder = { spawn: vi.fn() };
    const blockedExecutor = new KernelCommandExecutor(options(broken.host, blockedForwarder));
    await expect(
      blockedExecutor.spawn(command, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(blockedForwarder.spawn).not.toHaveBeenCalled();
    expect(broken.preparePiped).not.toHaveBeenCalled();

    const admission = makeHost({ spawn: () => kernelError("RESOURCE_LIMIT", "no process slot") });
    const admissionForwarder: KernelCommandForwarder = { spawn: vi.fn() };
    const admissionExecutor = new KernelCommandExecutor(
      options(admission.host, admissionForwarder),
    );
    await expect(
      admissionExecutor.spawn(command, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
    expect(admission.preparedRelease).toHaveBeenCalledTimes(1);
    expect(admissionForwarder.spawn).not.toHaveBeenCalled();

    const runtime = makeHost({
      exitStatus: () => Promise.resolve(kernelError("IO_ERROR", "local runtime failed")),
    });
    const runtimeForwarder: KernelCommandForwarder = { spawn: vi.fn() };
    const runtimeExecutor = new KernelCommandExecutor(options(runtime.host, runtimeForwarder));
    const runtimeChild = await runtimeExecutor.spawn(command, new AbortController().signal);
    await expect(runtimeChild.exited).rejects.toMatchObject({ code: "IO_ERROR" });
    await Promise.all([readAll(runtimeChild.stdout), readAll(runtimeChild.stderr)]);
    await runtimeChild.dispose();
    expect(runtimeForwarder.spawn).not.toHaveBeenCalled();
  });

  it("releases prepared resources after cancelled admission and releases its wake once", async () => {
    const waiting = deferred<void>();
    const controller = new AbortController();
    const local = makeHost({
      spawn: () => ({ status: "would_block", wakeToken: { id: "admission" } }),
      waitForWake: (_token, signal) =>
        new Promise((resolve) => {
          waiting.resolve();
          if (signal?.aborted) {
            resolve(kernelError("CANCELLED", "cancelled"));
          } else {
            signal?.addEventListener(
              "abort",
              () => resolve(kernelError("CANCELLED", "cancelled")),
              { once: true },
            );
          }
        }),
    });
    const forwarder: KernelCommandForwarder = { spawn: vi.fn() };
    const executor = new KernelCommandExecutor(options(local.host, forwarder));
    const spawning = executor.spawn(command, controller.signal);
    await waiting.promise;
    controller.abort();

    await expect(spawning).rejects.toMatchObject({ code: "CANCELLED" });
    expect(local.preparedRelease).toHaveBeenCalledTimes(1);
    expect(local.wakeRelease).toHaveBeenCalledTimes(1);
    expect(forwarder.spawn).not.toHaveBeenCalled();
  });

  it("deduplicates disposal and reaps only after exit and both output streams close", async () => {
    const exit = deferred<KernelResult<typeof exitStatus>>();
    const local = makeHost({
      exitStatus: () => exit.promise,
      openOutputs: true,
      onReap: (attempt) =>
        attempt === 1 ? kernelError("CANCELLED", "temporary table shutdown") : kernelOk(undefined),
      onSignal: (number) => {
        if (number === 9) exit.resolve(kernelOk({ exitCode: 0, signal: 9, coreDumped: false }));
      },
    });
    const executor = new KernelCommandExecutor(options(local.host, { spawn: vi.fn() }));
    const child = await executor.spawn(command, new AbortController().signal);
    const stdoutReader = child.stdout.getReader();
    expect(await stdoutReader.read()).toEqual({ value: stdoutBytes, done: false });

    expect(local.reap).not.toHaveBeenCalled();
    await child.dispose();
    expect(await stdoutReader.read()).toEqual({ value: undefined, done: true });

    expect(local.signal).toHaveBeenCalledTimes(1);
    expect(local.signal).toHaveBeenCalledWith(handle, 9);
    expect(local.sourceCancel).not.toHaveBeenCalled();
    expect(local.reap).toHaveBeenCalledTimes(2);
    expect(await child.exited).toEqual({ exitCode: 0, signal: 9, coreDumped: false });
  });

  it("keeps failed-completion errors observable without retrying a consumed reap", async () => {
    let consumed = false;
    const local = makeHost({
      exitStatus: () => Promise.resolve(kernelError("IO_ERROR", "child completion failed")),
      onReap: () => {
        consumed = true;
        return kernelError("IO_ERROR", "child completion failed");
      },
      info: () =>
        consumed
          ? kernelError("INVALID_HANDLE", "child was reaped")
          : kernelOk({ pid: 2, parentPid: 1, processGroupId: 1 }),
    });
    const child = await new KernelCommandExecutor(options(local.host, { spawn: vi.fn() })).spawn(
      command,
      new AbortController().signal,
    );

    await expect(child.exited).rejects.toMatchObject({ code: "IO_ERROR" });
    await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
    await child.dispose();
    await child.dispose();

    expect(local.reap).toHaveBeenCalledTimes(1);
    expect(local.host.processes.info).toHaveBeenCalledTimes(1);
  });

  it("runs a registered JavaScript program on the real filesystem and process host", async () => {
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [
        {
          path: "/",
          storage: createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n),
        },
      ],
    });
    const wakes = new KernelWakeRegistry();
    const registry = new KernelProgramRegistry();
    const observed: {
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
      cwd?: string;
    } = {};
    const expectedStdout = new Uint8Array([0, 255, 13, 10]);
    const expectedStderr = new Uint8Array([254, 0, 10]);
    const binding: KernelProgramBinding = {
      manifest: {
        name: "executor-inline",
        version: "1.0.0",
        abiVersion: ABI_VERSION,
        requiredCapabilities: [],
        entrypoint: "executor-inline-v1",
      },
      implementation: {
        kind: "javascript",
        runInline: (context) => {
          observed.args = [...context.args];
          observed.env = { ...context.env };
          observed.cwd = context.filesystem.cwd;
          context.filesystem.write(1, expectedStdout, null);
          context.filesystem.write(2, expectedStderr, null);
          return 17;
        },
      },
    };
    const registration = registry.register(binding.manifest);
    if (registration.status !== "ok") throw new Error("Program registration failed");
    const host = new KernelProgramHost({
      registry,
      wakes,
      programs: new Map([["/bin/inline", binding]]),
    });
    const forwarder: KernelCommandForwarder = { spawn: vi.fn() };
    const executor = new KernelCommandExecutor({
      host,
      filesystem,
      forwarder,
      home: "/home/guest",
    });
    const localCommand: KernelCommand = {
      executable: "/bin/inline",
      argv: ["argv-zero", "", "two words"],
      cwd: "/workspace/a b",
      env: { EMPTY: "", SENTINEL: "env value" },
    };
    filesystem.mkdir("/workspace");
    filesystem.mkdir("/workspace/a b");

    try {
      const child = await executor.spawn(localCommand, new AbortController().signal);
      const [stdout, stderr, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      expect(observed).toEqual({
        args: localCommand.argv,
        cwd: localCommand.cwd,
        env: localCommand.env,
      });
      expect(stdout).toEqual([...expectedStdout]);
      expect(stderr).toEqual([...expectedStderr]);
      expect(status).toEqual({ exitCode: 17, signal: 0, coreDumped: false });
      expect(forwarder.spawn).not.toHaveBeenCalled();
      await child.dispose();
    } finally {
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });
});

function options(
  host: KernelProgramHost,
  forwarder: KernelCommandForwarder,
  extra: Pick<KernelCommandExecutorOptions, "home"> = {},
): KernelCommandExecutorOptions {
  return {
    host,
    filesystem: {} as KernelFileSystem,
    forwarder,
    ...extra,
  };
}

function makeHost(
  overrides: {
    readonly resolve?: () => KernelResult<ResolvedProgram>;
    readonly spawn?: () => KernelResult<KernelHandle<"process">>;
    readonly exitStatus?: () => Promise<KernelResult<typeof exitStatus>>;
    readonly waitForWake?: (
      token: { readonly id: string },
      signal?: AbortSignal,
    ) => Promise<KernelResult<void>>;
    readonly onSignal?: (signal: number) => void;
    readonly onReap?: (attempt: number) => KernelResult<void>;
    readonly info?: () => KernelResult<KernelProcessInfo>;
    readonly openOutputs?: boolean;
  } = {},
) {
  const registry = new KernelProgramRegistry();
  if (registry.register(manifest).status !== "ok") throw new Error("Program registration failed");
  const resolutionBackend = {
    "process.spawn": () => kernelError("UNSUPPORTED", "resolution only"),
  } satisfies KernelBackend;
  const defaultResolve = () =>
    registry.resolve(manifest.name, manifest.version, [ABI_VERSION], resolutionBackend);
  let transferred = false;
  const preparedRelease = vi.fn<() => void>();
  const prepared = {
    release: async () => {
      if (!transferred) preparedRelease();
    },
  };
  const sourceCancel = vi.fn<() => void>();
  const stdinBytes: Uint8Array[] = [];
  const piped = makePiped(
    stdoutBytes,
    stderrBytes,
    sourceCancel,
    !overrides.openOutputs,
    stdinBytes,
  );
  const spawn = vi.fn(() => {
    const result = overrides.spawn?.() ?? kernelOk(handle);
    if (result.status === "ok") transferred = true;
    return result;
  });
  const processes = {
    info: vi.fn(() => overrides.info?.() ?? kernelOk({ pid: 2, parentPid: 1, processGroupId: 1 })),
    signal: vi.fn((actualHandle: KernelHandle<"process">, number: number) => {
      expect(actualHandle).toEqual(handle);
      piped.closeOutputs();
      overrides.onSignal?.(number);
      return kernelOk(undefined);
    }),
  };
  let reapAttempts = 0;
  const reap = vi.fn(() => overrides.onReap?.(++reapAttempts) ?? kernelOk(undefined));
  const wait = vi.fn(
    (token: { readonly id: string }, signal?: AbortSignal) =>
      overrides.waitForWake?.(token, signal) ?? Promise.resolve(kernelOk(undefined)),
  );
  const wakeRelease = vi.fn();
  const filesystem = {} as KernelFileSystem;
  const preparePiped = vi.fn((input: unknown, prepareOptions: unknown) => {
    prepareInput = input;
    prepareOptionsCaptured = prepareOptions;
    return { ...piped, prepared };
  });
  let prepareInput: unknown;
  let prepareOptionsCaptured: unknown;
  let spawnInput: unknown;
  const actualBackend = {
    "process.spawn": (input: Parameters<NonNullable<KernelBackend["process.spawn"]>>[0]) => {
      spawnInput = input;
      return spawn();
    },
  } satisfies KernelBackend;
  const host = {
    resolve: vi.fn(() => overrides.resolve?.() ?? defaultResolve()),
    preparePiped,
    backend: vi.fn(() => actualBackend),
    exitStatus: vi.fn(() => overrides.exitStatus?.() ?? Promise.resolve(kernelOk(exitStatus))),
    processes,
    reap,
    wakes: { wait, release: wakeRelease },
  } as unknown as KernelProgramHost;

  return {
    host,
    filesystem,
    stdinBytes,
    preparePiped,
    sourceCancel,
    signal: processes.signal,
    reap,
    wakeRelease,
    preparedRelease,
    get prepareInput() {
      return prepareInput;
    },
    get prepareOptions() {
      return prepareOptionsCaptured;
    },
    get spawnInput() {
      return spawnInput;
    },
  };
}

function makeChild(
  status: typeof exitStatus,
  stdout: Uint8Array,
  stderr: Uint8Array,
): { readonly child: KernelCommandChild; readonly stdinBytes: Uint8Array[] } {
  const stdinBytes: Uint8Array[] = [];
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      stdinBytes.push(new Uint8Array(chunk));
    },
  });
  return {
    stdinBytes,
    child: {
      stdin,
      stdout: bytesStream(stdout),
      stderr: bytesStream(stderr),
      exited: Promise.resolve(status),
      signal: async () => kernelOk(undefined),
      dispose: async () => undefined,
    },
  };
}

function makePiped(
  stdout: Uint8Array,
  stderr: Uint8Array,
  sourceCancel: () => void,
  closeOutputs: boolean,
  stdinBytes: Uint8Array[],
) {
  const prepared = { release: vi.fn(async () => undefined) };
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      stdinBytes.push(new Uint8Array(chunk));
    },
  });
  const stdoutStream = bytesStreamWithController(stdout, sourceCancel, closeOutputs);
  const stderrStream = bytesStreamWithController(stderr, sourceCancel, closeOutputs);
  return {
    prepared,
    stdin: input,
    stdout: stdoutStream.stream,
    stderr: stderrStream.stream,
    closeOutputs: () => {
      stdoutStream.close();
      stderrStream.close();
    },
  };
}

function bytesStream(
  bytes: Uint8Array,
  onCancel: () => void = () => {},
  close = true,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
      if (close) controller.close();
    },
    cancel() {
      onCancel();
    },
  });
}

function bytesStreamWithController(bytes: Uint8Array, onCancel: () => void, close: boolean) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
      if (close) controller.close();
    },
    cancel() {
      onCancel();
    },
  });
  return {
    stream,
    close: () => {
      try {
        controller?.close();
      } catch {
        // The source may already have closed.
      }
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader();
  const bytes: number[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) return bytes;
    bytes.push(...result.value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
