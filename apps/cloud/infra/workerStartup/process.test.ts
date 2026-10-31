// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - These cases exercise the native process boundary with in-memory child handles.
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runStartupProfiler } from "./process.ts";

const limits = {
  deadlineMs: 10_000,
  sampleMs: 10_000,
  terminateMs: 10,
  killWaitMs: 10,
  rssBytes: 100,
  logBytes: 8,
  outputBytes: 1024,
  profileBytes: 128,
  diskFloorBytes: 100,
};

function makeChild(pid = 4101) {
  const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
    pid: number;
    stdout: NodeStream.PassThrough;
    stderr: NodeStream.PassThrough;
  };
  child.pid = pid;
  child.stdout = new NodeStream.PassThrough();
  child.stderr = new NodeStream.PassThrough();
  return child;
}

function ledger(pid = 9201) {
  return (
    [
      { event: "workerd-spawn", pid, guardPassed: true },
      {
        event: "workerd-close",
        pid,
        code: 0,
        signal: null,
        streamsClosed: [true, true, true, true],
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n"
  );
}

async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-startup-process-"));
  const output = NodePath.join(root, "attempt");
  await NodeFSP.mkdir(output);
  const ledgerFile = NodePath.join(output, "native-children.jsonl");
  const profileFile = NodePath.join(output, "startup.cpuprofile");
  const input = {
    command: ["node", "wrangler"],
    cwd: root,
    env: {},
    output,
    ledgerFile,
    profileFile,
    limits,
  } as const;
  return { root, input };
}

function adapter(
  child: ReturnType<typeof makeChild>,
  options: {
    rows?: () => Promise<
      Array<{ pid: number; parentPid: number; group: number; rssBytes: number }>
    >;
    onSignal?: (signal: NodeJS.Signals) => void;
    spawn?: () => void;
  } = {},
) {
  return {
    spawn: (() => {
      options.spawn?.();
      return child as unknown as ReturnType<typeof NodeChildProcess.spawn>;
    }) as typeof NodeChildProcess.spawn,
    signalGroup: (_group: number, signal: NodeJS.Signals) => options.onSignal?.(signal),
    groupProcesses: options.rows ?? (async () => []),
    freeBytes: async () => 10_000,
    outputBytes: async () => 0,
    admission: vi.fn(),
    now: () => performance.now(),
  };
}

function closeChild(
  child: ReturnType<typeof makeChild>,
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
) {
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => child.emit("close", code, signal));
}

afterEach(() => vi.restoreAllMocks());

describe("startup profiler process ownership", () => {
  it("returns only after Wrangler streams, the native ledger, and its process group close", async () => {
    const { root, input } = await setup();
    const child = makeChild();
    await NodeFSP.writeFile(input.ledgerFile, ledger());
    const result = await runStartupProfiler(
      input,
      adapter(child, { spawn: () => closeChild(child) }),
    );
    expect(result).toMatchObject({
      terminal: { code: 0, signal: null },
      wranglerPid: child.pid,
      wranglerWaited: true,
      joined: true,
      remainingOwnedGroup: [],
    });
    expect(await NodeFSP.readFile(NodePath.join(input.output, "closure.json"), "utf8")).toContain(
      '"joined": true',
    );
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("exports a resource failure before sending TERM and waits for the close event", async () => {
    const { root, input } = await setup();
    const child = makeChild();
    let rows = [{ pid: child.pid, parentPid: process.pid, group: child.pid, rssBytes: 101 }];
    const signals: NodeJS.Signals[] = [];
    const run = runStartupProfiler(
      input,
      adapter(child, {
        rows: async () => rows,
        onSignal: (signal) => {
          expect(
            JSON.parse(
              NodeFS.readFileSync(NodePath.join(input.output, "first-failure.json"), "utf8"),
            ).message,
          ).toContain("RESOURCE_LIMIT");
          signals.push(signal);
          rows = [];
          closeChild(child, null, "SIGTERM");
        },
      }),
    );
    await expect(run).rejects.toThrow("WORKER_STARTUP_RESOURCE_LIMIT");
    const closure = JSON.parse(
      await NodeFSP.readFile(NodePath.join(input.output, "closure.json"), "utf8"),
    );
    expect(closure.wranglerWaited).toBe(true);
    expect(closure.failure).toContain("WORKER_STARTUP_RESOURCE_LIMIT");
    expect(signals).toEqual(["SIGTERM"]);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("cleans a surviving descendant after Wrangler closes and records the failure", async () => {
    const { root, input } = await setup();
    const child = makeChild();
    await NodeFSP.writeFile(input.ledgerFile, ledger());
    let rows = [{ pid: 9202, parentPid: child.pid, group: child.pid, rssBytes: 1 }];
    const signals: NodeJS.Signals[] = [];
    const run = runStartupProfiler(
      input,
      adapter(child, {
        rows: async () => rows,
        spawn: () => closeChild(child),
        onSignal: (signal) => {
          signals.push(signal);
          rows = [];
        },
      }),
    );
    await expect(run).rejects.toThrow("WORKER_STARTUP_DESCENDANTS_AFTER_WRANGLER_EXIT");
    const closure = JSON.parse(
      await NodeFSP.readFile(NodePath.join(input.output, "closure.json"), "utf8"),
    );
    expect(closure.wranglerWaited).toBe(true);
    expect(closure.remainingOwnedGroup).toEqual([]);
    expect(signals).toEqual(["SIGTERM"]);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("retains closure evidence when the native ledger is missing", async () => {
    const { root, input } = await setup();
    const child = makeChild();
    const run = runStartupProfiler(input, adapter(child, { spawn: () => closeChild(child) }));
    await expect(run).rejects.toThrow("WORKER_STARTUP_LEDGER_INVALID");
    const closure = JSON.parse(
      await NodeFSP.readFile(NodePath.join(input.output, "closure.json"), "utf8"),
    );
    expect(closure.wranglerWaited).toBe(true);
    expect(closure.ledgerError).toContain("ENOENT");
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("keeps ownership after the kill deadline until the child actually closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { root, input } = await setup();
    const child = makeChild();
    const spawned = Promise.withResolvers<void>();
    const signals: NodeJS.Signals[] = [];
    let settled = false;
    try {
      const run = runStartupProfiler(
        { ...input, limits: { ...limits, terminateMs: 10, killWaitMs: 10 } },
        adapter(child, {
          spawn: () => spawned.resolve(),
          onSignal: (signal) => signals.push(signal),
        }),
      );
      const outcome = run.then(
        () => {
          settled = true;
          return undefined;
        },
        (cause: unknown) => {
          settled = true;
          return cause;
        },
      );
      await spawned.promise;
      child.emit("error", new Error("spawn failed"));
      await vi.advanceTimersByTimeAsync(30);
      const uncertain = JSON.parse(
        await NodeFSP.readFile(NodePath.join(input.output, "uncertain-closure.json"), "utf8"),
      );
      expect(uncertain).toMatchObject({
        supervisionRetained: true,
        wranglerWaited: false,
        terminal: null,
      });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(settled).toBe(false);
      await expect(NodeFSP.stat(NodePath.join(input.output, "closure.json"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      closeChild(child, null, "SIGKILL");
      expect(await outcome).toMatchObject({ message: "spawn failed" });
      const closure = JSON.parse(
        await NodeFSP.readFile(NodePath.join(input.output, "closure.json"), "utf8"),
      );
      expect(closure).toMatchObject({
        wranglerWaited: true,
        terminationDeadlineExceeded: true,
        terminal: { code: null, signal: "SIGKILL" },
        remainingOwnedGroup: [],
      });
    } finally {
      vi.useRealTimers();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
