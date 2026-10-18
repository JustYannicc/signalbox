import { describe, expect, it } from "vite-plus/test";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandExit,
  KernelCommandForwarder,
} from "./KernelCommandForwarder.ts";
import { kernelOk, type KernelResult } from "./KernelAbi.ts";
import { CodexExecProcesses } from "./CodexExecProcesses.ts";
import { CodexExecSessions } from "./CodexExecSessions.ts";
import { fileUriToGuestPath, prepareProcessLaunch } from "./execServer/ProcessesLaunch.ts";
import { RpcError, type Notification, type Reply } from "./CodexExecProtocol.ts";

const launch = {
  processId: "process-1",
  argv: ["/usr/bin/tool"],
  cwd: "file:///workspace/a%20b",
  env: {},
  tty: false,
  pipeStdin: true,
};

type ChildOptions = {
  readonly write?: (chunk: Uint8Array) => void | Promise<void>;
  readonly signal?: (number: number) => KernelResult<void> | Promise<KernelResult<void>>;
  readonly dispose?: () => void | Promise<void>;
};

function makeChild(options: ChildOptions = {}) {
  const writes: Uint8Array[] = [];
  const signals: number[] = [];
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (status: KernelCommandExit) => void;
  let exited = false;
  let stdoutClosed = false;
  let stderrClosed = false;
  let disposeCalls = 0;
  const exitStatus = new Promise<KernelCommandExit>((resolve) => {
    resolveExit = resolve;
  });
  const closeStdout = () => {
    if (stdoutClosed) return;
    stdoutClosed = true;
    try {
      stdoutController.close();
    } catch {
      // A disposed child may already have cancelled the reader.
    }
  };
  const closeStderr = () => {
    if (stderrClosed) return;
    stderrClosed = true;
    try {
      stderrController.close();
    } catch {
      // A disposed child may already have cancelled the reader.
    }
  };
  const finishExit = (status: KernelCommandExit) => {
    if (exited) return;
    exited = true;
    resolveExit(status);
  };
  const child: KernelCommandChild = {
    stdin: new WritableStream<Uint8Array>({
      async write(chunk) {
        const owned = Uint8Array.from(chunk);
        writes.push(owned);
        await options.write?.(owned);
      },
    }),
    stdout: new ReadableStream<Uint8Array>(
      { start: (controller) => (stdoutController = controller) },
      { highWaterMark: 0 },
    ),
    stderr: new ReadableStream<Uint8Array>(
      { start: (controller) => (stderrController = controller) },
      { highWaterMark: 0 },
    ),
    exited: exitStatus,
    signal: async (number) => {
      signals.push(number);
      return (await options.signal?.(number)) ?? kernelOk(undefined);
    },
    dispose: async () => {
      disposeCalls++;
      await options.dispose?.();
      closeStdout();
      closeStderr();
      finishExit({ exitCode: 0, signal: 0, coreDumped: false });
    },
  };
  return {
    child,
    writes,
    signals,
    finishExit,
    pushStdout: (bytes: Uint8Array) => stdoutController.enqueue(Uint8Array.from(bytes)),
    pushStderr: (bytes: Uint8Array) => stderrController.enqueue(Uint8Array.from(bytes)),
    closeStdout,
    closeStderr,
    get disposeCalls() {
      return disposeCalls;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(
  options: {
    readonly spawn?: KernelCommandForwarder["spawn"];
    readonly baseEnv?: Readonly<Record<string, string>>;
    readonly platformOs?: string;
    readonly maxWriteBytesPerProcess?: number;
    readonly maxDedupBytesPerProcess?: number;
  } = {},
) {
  const session = new AbortController();
  const notifications: Notification[] = [];
  const waiters = new Set<{
    readonly method: string;
    readonly after: number;
    readonly count: number;
    readonly resolve: (items: Notification[]) => void;
  }>();
  const commands: KernelCommand[] = [];
  const children: ReturnType<typeof makeChild>[] = [];
  const notify = async (message: Notification) => {
    notifications.push(message);
    for (const waiter of waiters) {
      const matching = notifications
        .slice(waiter.after)
        .filter((item) => item.method === waiter.method);
      if (matching.length >= waiter.count) {
        waiters.delete(waiter);
        waiter.resolve(matching);
      }
    }
  };
  const defaultSpawn: KernelCommandForwarder["spawn"] = async (command) => {
    commands.push(command);
    const child = makeChild();
    children.push(child);
    return child.child;
  };
  const spawn = options.spawn ?? defaultSpawn;
  const handler = new CodexExecProcesses({
    spawn,
    notify,
    sessionSignal: session.signal,
    baseEnv: options.baseEnv ?? {},
    ...(options.platformOs === undefined ? {} : { platformOs: options.platformOs }),
    ...(options.maxWriteBytesPerProcess === undefined
      ? {}
      : { maxWriteBytesPerProcess: options.maxWriteBytesPerProcess }),
    ...(options.maxDedupBytesPerProcess === undefined
      ? {}
      : { maxDedupBytesPerProcess: options.maxDedupBytesPerProcess }),
  });
  const waitForNotifications = (method: string, count = 1, after = 0) => {
    const matching = notifications.slice(after).filter((item) => item.method === method);
    if (matching.length >= count) return Promise.resolve(matching);
    return new Promise<Notification[]>((resolve) => {
      waiters.add({ method, after, count, resolve });
    });
  };
  return { handler, session, notifications, waitForNotifications, commands, children };
}

const frame = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ id, method, params });
const requestSignal = () => new AbortController().signal;
const writeRequest = (writeId: string, bytes: Uint8Array) => ({
  processId: launch.processId,
  writeId,
  chunk: Buffer.from(bytes).toString("base64"),
});

describe("Codex exec-server process handling", () => {
  it("preserves argv0 and cwd, applies upstream environment policy, and deduplicates starts", async () => {
    const child = makeChild();
    const commands: KernelCommand[] = [];
    const fixture = harness({
      baseEnv: {
        PATH: "/base/bin",
        HOME: "/home/user",
        API_TOKEN: "private",
        SET_OLD: "removed",
        SETTINGS: "removed",
      },
      platformOs: "linux",
      spawn: async (command) => {
        commands.push(command);
        return child.child;
      },
    });
    const params = {
      ...launch,
      argv: ["/usr/bin/tool", "first", ""],
      arg0: "tool alias",
      env: { PATH: "/caller/bin", CALLER_ONLY: "explicit" },
      envPolicy: {
        inherit: "core",
        ignoreDefaultExcludes: false,
        exclude: ["SET_OLD", "SETTINGS"],
        set: { SET_NEW: "policy" },
        includeOnly: ["PATH", "SET_*"],
      },
    };
    try {
      const response = await fixture.handler.request("process/start", params, requestSignal());
      expect(response).toEqual({ processId: launch.processId, sandboxType: "none" });
      expect(commands).toEqual([
        {
          executable: "/usr/bin/tool",
          argv: ["tool alias", "first", ""],
          cwd: "/workspace/a b",
          env: {
            PATH: "/caller/bin",
            SET_NEW: "policy",
            CALLER_ONLY: "explicit",
          },
        },
      ]);
      expect(await fixture.handler.request("process/start", params, requestSignal())).toEqual(
        response,
      );
      await expect(
        fixture.handler.request(
          "process/start",
          { ...params, env: { ...params.env, CALLER_ONLY: "changed" } },
          requestSignal(),
        ),
      ).rejects.toThrow("different parameters");
      expect(commands).toHaveLength(1);
    } finally {
      await fixture.handler.dispose();
    }
  });

  it("rejects lossy file URIs and unsupported process modes before launch", () => {
    expect(fileUriToGuestPath("file:///workspace/folder%20name")).toBe("/workspace/folder name");
    for (const cwd of [
      "file://localhost/workspace",
      "file://server/share",
      "file:///workspace/%2Fetc",
      "file:///workspace/%00file",
      "file:///workspace?query",
      "file:///workspace#fragment",
      "file:\\workspace",
    ]) {
      expect(() => fileUriToGuestPath(cwd)).toThrow(RpcError);
    }

    const environment = { baseEnv: { PATH: "/bin" }, platformOs: "linux" };
    const unsupported = [
      { tty: true },
      { sandbox: {} },
      { shellSnapshot: {} },
      { enforceManagedNetwork: true },
      { managedNetwork: {} },
      { networkProxy: {} },
    ];
    for (const patch of unsupported) {
      expect(() => prepareProcessLaunch({ ...launch, ...patch }, environment)).toThrow(
        "unsupported",
      );
    }

    const windows = prepareProcessLaunch(
      {
        ...launch,
        envPolicy: {
          inherit: "core",
          ignoreDefaultExcludes: true,
          exclude: [],
          set: {},
          includeOnly: [],
        },
      },
      {
        baseEnv: {
          PATH: "C:\\bin",
          PATHEXT: ".EXE",
          USERPROFILE: "C:\\Users\\user",
          TEMP: "C:\\Temp",
          LOCALAPPDATA: "C:\\Users\\user\\AppData",
          PWSH: "C:\\Program Files\\PowerShell\\pwsh.exe",
        },
        platformOs: "windows",
      },
    );
    expect(windows.command.env).toEqual({
      PATH: "C:\\bin",
      PATHEXT: ".EXE",
      USERPROFILE: "C:\\Users\\user",
    });

    expect(() =>
      prepareProcessLaunch({ ...launch, env: { LARGE: "€".repeat(90_000) } }, environment),
    ).toThrow("size limit");
  });

  it("rejects a stdin chunk that cannot retain its deduplication identity", async () => {
    const child = makeChild();
    const fixture = harness({
      spawn: async () => child.child,
      maxWriteBytesPerProcess: 2,
      maxDedupBytesPerProcess: 1,
    });
    try {
      await fixture.handler.request("process/start", launch, requestSignal());
      await expect(
        fixture.handler.request(
          "process/write",
          writeRequest("too-large-for-dedup", Uint8Array.from([1, 2])),
          requestSignal(),
        ),
      ).rejects.toThrow("deduplication limit");
      expect(child.writes).toEqual([]);
    } finally {
      await fixture.handler.dispose();
    }
  });

  it.each([
    [{ exitCode: 7, signal: 0, coreDumped: false }, 7],
    [{ exitCode: 0, signal: 15, coreDumped: false }, 143],
    [{ exitCode: 0, signal: -1, coreDumped: false }, -1],
  ] as const)("maps upstream exit status %o to wire code %i", async (status, exitCode) => {
    const child = makeChild();
    const fixture = harness({ spawn: async () => child.child });
    try {
      await fixture.handler.request("process/start", launch, requestSignal());
      const exitedEvent = fixture.waitForNotifications("process/exited");
      child.finishExit(status);
      const [message] = await exitedEvent;
      expect(message?.params).toMatchObject({ exitCode, sandboxDenied: false });
    } finally {
      await fixture.handler.dispose();
    }
  });

  it("serializes writes, waits for stream acceptance, and closes only after EOF and cleanup", async () => {
    const writeGate = deferred<void>();
    const writeEntered = deferred<void>();
    const signalGate = deferred<void>();
    const signalEntered = deferred<void>();
    const cleanupGate = deferred<void>();
    const cleanupEntered = deferred<void>();
    const child = makeChild({
      write: async () => {
        writeEntered.resolve();
        await writeGate.promise;
      },
      signal: async (number) => {
        if (number === 2) {
          signalEntered.resolve();
          await signalGate.promise;
        }
        return kernelOk(undefined);
      },
      dispose: async () => {
        cleanupEntered.resolve();
        await cleanupGate.promise;
      },
    });
    const fixture = harness({
      spawn: async () => child.child,
    });
    try {
      await fixture.handler.request("process/start", launch, requestSignal());
      const bytes = Uint8Array.from([0, 255, 128]);
      const first = fixture.handler.request(
        "process/write",
        writeRequest("write-1", bytes),
        requestSignal(),
      );
      await writeEntered.promise;
      let accepted = false;
      void first.then(() => (accepted = true));
      await Promise.resolve();
      expect(accepted).toBe(false);
      const retry = fixture.handler.request(
        "process/write",
        writeRequest("write-1", bytes),
        requestSignal(),
      );
      writeGate.resolve();
      expect(await first).toEqual({ status: "accepted" });
      expect(await retry).toEqual({ status: "accepted" });
      expect(child.writes).toEqual([bytes]);
      await expect(
        fixture.handler.request(
          "process/write",
          writeRequest("write-1", Uint8Array.from([1])),
          requestSignal(),
        ),
      ).rejects.toThrow("different bytes");

      const signal = fixture.handler.request(
        "process/signal",
        { processId: launch.processId, signal: "interrupt" },
        requestSignal(),
      );
      await signalEntered.promise;
      let acknowledged = false;
      void signal.then(() => (acknowledged = true));
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      signalGate.resolve();
      expect(await signal).toEqual({});
      expect(child.signals).toEqual([2]);

      const exitEvents = fixture.waitForNotifications("process/exited");
      child.finishExit({ exitCode: 0, signal: 0, coreDumped: false });
      const [exited] = await exitEvents;
      expect(exited?.params).toMatchObject({ exitCode: 0, sandboxDenied: false });
      expect(
        await fixture.handler.request(
          "process/write",
          writeRequest("after-exit", Uint8Array.from([1])),
          requestSignal(),
        ),
      ).toEqual({ status: "stdinClosed" });

      const beforeOutput = fixture.notifications.length;
      const outputEvents = fixture.waitForNotifications("process/output", 2, beforeOutput);
      child.pushStdout(Uint8Array.from([65]));
      child.pushStderr(Uint8Array.from([66]));
      const outputs = await outputEvents;
      const outputParams = outputs.map((item) => item.params as { seq: number; stream: string });
      expect(outputParams.map((item) => item.stream).sort()).toEqual(["stderr", "stdout"]);
      expect(new Set(outputParams.map((item) => item.seq)).size).toBe(2);
      const replay = await fixture.handler.request(
        "process/read",
        { processId: launch.processId, afterSeq: 0 },
        requestSignal(),
      );
      expect(replay).toMatchObject({
        exited: true,
        closed: false,
        chunks: [{ seq: 2 }, { seq: 3 }],
      });

      const beforeClosed = fixture.notifications.length;
      const closedEvent = fixture.waitForNotifications("process/closed", 1, beforeClosed);
      child.closeStdout();
      child.closeStderr();
      await cleanupEntered.promise;
      expect(
        fixture.notifications.slice(beforeClosed).some((item) => item.method === "process/closed"),
      ).toBe(false);
      cleanupGate.resolve();
      const [closed] = await closedEvent;
      expect(closed?.params).toMatchObject({ processId: launch.processId, seq: 4 });
      expect(child.disposeCalls).toBe(1);
    } finally {
      writeGate.resolve();
      signalGate.resolve();
      cleanupGate.resolve();
      await fixture.handler.dispose();
    }
  });

  it("aborts pending admission and retries cleanup for a child returned after cancellation", async () => {
    const spawnEntered = deferred<AbortSignal>();
    let disposeAttempts = 0;
    const lateChild = makeChild({
      dispose: () => {
        disposeAttempts++;
        if (disposeAttempts === 1) throw new Error("temporary dispose failure");
      },
    });
    let spawnChild!: (child: KernelCommandChild) => void;
    let spawnResolved = false;
    const childResult = new Promise<KernelCommandChild>((resolve) => {
      spawnChild = (child) => {
        spawnResolved = true;
        resolve(child);
      };
    });
    const fixture = harness({
      spawn: async (_command, signal) => {
        spawnEntered.resolve(signal);
        return childResult;
      },
    });
    try {
      expect(
        await fixture.handler.request(
          "process/write",
          writeRequest("before-start", Uint8Array.from([1])),
          requestSignal(),
        ),
      ).toEqual({ status: "unknownProcess" });
      const starting = fixture.handler.request("process/start", launch, requestSignal());
      const childSignal = await spawnEntered.promise;
      expect(
        await fixture.handler.request(
          "process/write",
          writeRequest("during-start", Uint8Array.from([1])),
          requestSignal(),
        ),
      ).toEqual({ status: "starting" });
      expect(
        await fixture.handler.request(
          "process/terminate",
          { processId: launch.processId },
          requestSignal(),
        ),
      ).toEqual({ running: true });
      expect(childSignal.aborted).toBe(true);
      spawnChild(lateChild.child);
      await expect(starting).rejects.toMatchObject({ name: "AbortError" });
      await fixture.handler.dispose();
      expect(lateChild.disposeCalls).toBe(2);
    } finally {
      if (!spawnResolved) spawnChild(lateChild.child);
      await fixture.handler.dispose();
    }
  });

  it("replays process output through the same handler after protocol reconnect", async () => {
    const child = makeChild();
    let handler: CodexExecProcesses | undefined;
    let createdSessions = 0;
    const sessions = new CodexExecSessions({
      environmentInfo: {
        shell: { name: "sh", path: "/bin/sh" },
        executorVersion: "test",
      },
      createSession: ({ signal, notify }) => {
        createdSessions++;
        const processHandler = new CodexExecProcesses({
          spawn: async () => child.child,
          notify,
          sessionSignal: signal,
          baseEnv: {},
        });
        handler = processHandler;
        return processHandler;
      },
      onCleanupError: () => {},
    });
    const firstMessages: (Reply | Notification)[] = [];
    const first = sessions.connect((message) => {
      firstMessages.push(message);
    });
    try {
      await first.receive(frame(1, "initialize", { clientName: "codex" }));
      const initialize = firstMessages.at(-1);
      if (!initialize || !("result" in initialize)) throw new Error("Initialization failed");
      const sessionId = (initialize.result as { sessionId: string }).sessionId;
      await first.receive('{"method":"initialized"}');
      await first.receive(frame(2, "process/start", launch));
      expect(firstMessages.at(-1)).toMatchObject({
        id: 2,
        result: { processId: launch.processId },
      });

      first.disconnect();
      const directRead = handler!.request(
        "process/read",
        { processId: launch.processId, afterSeq: 0, waitMs: 30_000 },
        requestSignal(),
      );
      child.pushStdout(Uint8Array.from([67]));
      expect(await directRead).toMatchObject({ chunks: [{ stream: "stdout" }], closed: false });

      const resumedMessages: (Reply | Notification)[] = [];
      const resumed = sessions.connect((message) => {
        resumedMessages.push(message);
      });
      await resumed.receive(
        frame(1, "initialize", { clientName: "codex", resumeSessionId: sessionId }),
      );
      await resumed.receive('{"method":"initialized"}');
      await resumed.receive(frame(2, "process/read", { processId: launch.processId, afterSeq: 0 }));
      expect(resumedMessages.at(-1)).toMatchObject({
        id: 2,
        result: { chunks: [{ seq: 1, stream: "stdout", chunk: "Qw==" }], closed: false },
      });
      expect(createdSessions).toBe(1);
    } finally {
      await sessions.dispose();
    }
  });
});
