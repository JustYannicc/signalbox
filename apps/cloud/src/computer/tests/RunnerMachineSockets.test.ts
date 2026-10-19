import { describe, expect, it, vi } from "vite-plus/test";
import {
  RUNNER_PROTOCOL_VERSION,
  runnerFrame,
  threadFrame,
  type RunnerHello,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunnerCommandConfig } from "@signalbox/runner-protocol/RunnerCommandProtocol";
import { RunnerMachineSockets } from "../RunnerMachineSockets.ts";
import { createRunnerMachineRuntime } from "../RunnerMachineRuntime.ts";
import type { RunnerExecSocketHost } from "../../thread/ThreadExecForwarder.ts";
import { ThreadId } from "@t3tools/contracts";

const machine = { id: "owned-fork", generation: 4, release: async () => undefined };
const owner = { operationId: "command-1", machineId: machine.id, generation: machine.generation };
const threadId = ThreadId.make("command-thread");
const signal = new AbortController().signal;
const command = {
  executable: "/bin/bash",
  argv: ["custom argv0", ""],
  cwd: "/workspace",
  env: { EXACT: "雪", EMPTY: "" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function socketFixture() {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    accept: vi.fn(),
    addEventListener: vi.fn(),
    send: (value: string) => {
      sent.push(value);
    },
    close: vi.fn(),
  } as unknown as WebSocket;
  return { socket, sent };
}

function fixture(launchFinished = Promise.resolve()) {
  const launched = deferred<RunnerCommandConfig>();
  const quiesce = vi.fn(async () => ({ ...owner, closed: true as const }));
  const adapter = new RunnerMachineSockets({
    endpoint: "wss://proof.invalid/api/computer/runner",
    threadId,
    workspaceReceipt: "/run/signalbox-command/workspace.json",
    cgroupPath: () => "/sys/fs/cgroup/signalbox-command/owned-proof",
    launch: async (config) => {
      launched.resolve(config);
      await launchFinished;
    },
    quiesce,
  });
  const socketHost: RunnerExecSocketHost = {
    connected: vi.fn(),
    report: vi.fn(),
    disconnected: vi.fn(),
    generationEnded: vi.fn(),
  };
  const input = { operationId: owner.operationId, machine, socketHost, signal };
  const hello = (config: RunnerCommandConfig, patch: Partial<RunnerHello> = {}) =>
    runnerFrame.encode({
      type: "hello",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      imageVersion: "command-v1",
      machineId: config.machineId,
      threadId,
      generation: config.generation,
      token: config.token,
      lastAckedSequence: 0,
      exec: true,
      ...patch,
    });
  return { adapter, launched, quiesce, socketHost, input, hello };
}

describe("RunnerMachineSockets", () => {
  it("authenticates the exact fresh fork and forwards byte reports through its accepted socket", async () => {
    const f = fixture();
    const pending = f.adapter.connect(f.input);
    const config = await f.launched.promise;
    expect(config).toMatchObject({
      ...owner,
      threadId,
      cgroupPath: "/sys/fs/cgroup/signalbox-command/owned-proof",
    });
    expect(new URL(config.endpoint).search).toBe("");
    const wrong = socketFixture();
    f.adapter.accept(wrong.socket);
    f.adapter.message(wrong.socket, f.hello(config, { machineId: "wrong-fork" }));
    expect(wrong.socket.close).toHaveBeenCalledWith(1008, "Command Runner frame rejected");
    expect(f.socketHost.connected).not.toHaveBeenCalled();
    const live = socketFixture();
    f.adapter.accept(live.socket);
    f.adapter.message(live.socket, f.hello(config));
    const connection = await pending;
    expect(connection.owner).toEqual(owner);
    expect(threadFrame.decode(live.sent[0])).toEqual({
      type: "welcome",
      generation: 4,
      ackedSequence: 0,
      activeRunId: null,
    });
    const report = {
      type: "output" as const,
      generation: 4,
      processId: "p",
      sequence: 1,
      stream: "stdout" as const,
      dataBase64: "AP+A",
    };
    f.adapter.message(live.socket, runnerFrame.encode({ type: "exec.report", report }));
    expect(f.socketHost.report).toHaveBeenCalledWith(live.socket, 4, 1, report);
    const replay = socketFixture();
    f.adapter.accept(replay.socket);
    f.adapter.message(replay.socket, f.hello(config));
    expect(replay.socket.close).toHaveBeenCalled();
    expect(f.socketHost.connected).toHaveBeenCalledTimes(1);
    await f.adapter.quiesce(f.input);
    await connection.dispose();
  });

  it("retains the lease after disconnect and rejects mismatched native closure", async () => {
    const f = fixture();
    const pending = f.adapter.connect(f.input);
    const config = await f.launched.promise;
    const live = socketFixture();
    f.adapter.accept(live.socket);
    f.adapter.message(live.socket, f.hello(config));
    const connection = await pending;
    const lease = await connection.lease.acquire(signal);
    f.adapter.closed(live.socket);
    expect(f.socketHost.disconnected).toHaveBeenCalledWith(live.socket, 4, 1);
    expect(f.socketHost.generationEnded).not.toHaveBeenCalled();
    await expect(connection.dispose()).rejects.toThrow("still live");
    f.quiesce.mockResolvedValueOnce({ ...owner, generation: 5, closed: true });
    await expect(f.adapter.quiesce(f.input)).rejects.toThrow("another operation");
    await expect(connection.dispose()).rejects.toThrow("still live");
    await f.adapter.quiesce(f.input);
    await expect(connection.dispose()).rejects.toThrow("still live");
    await lease.release();
    await lease.release();
    await connection.dispose();
  });

  it("carries the complete command through runtime admission and settles only after provider closure", async () => {
    const f = fixture();
    const runtime = createRunnerMachineRuntime(f.adapter);
    const bindingPromise = runtime.attach({
      ...f.input,
      workspace: { canonicalCwd: async () => command.cwd },
      policy: { authorize: async () => undefined },
    });
    const config = await f.launched.promise;
    const live = socketFixture();
    f.adapter.accept(live.socket);
    f.adapter.message(live.socket, f.hello(config));
    const binding = await bindingPromise;
    const spawn = binding.spawn(command, signal);
    // The workspace/policy awaits are observable through the next outgoing frame.
    const sent = deferred<string>();
    const originalSend = live.socket.send.bind(live.socket);
    live.socket.send = (value) => {
      if (typeof value !== "string") throw new Error("Expected a text frame");
      originalSend(value);
      sent.resolve(value);
    };
    const start = threadFrame.decode(await sent.promise);
    if (start.type !== "exec.command" || start.command.type !== "start")
      throw new Error("Missing start");
    expect(start.command).toMatchObject(command);
    f.adapter.message(
      live.socket,
      runnerFrame.encode({
        type: "exec.report",
        report: {
          type: "ack",
          generation: 4,
          processId: start.command.processId,
          operation: "start",
          requestId: start.command.requestId,
          applied: true,
        },
      }),
    );
    const child = await spawn;
    f.adapter.message(
      live.socket,
      runnerFrame.encode({
        type: "exec.report",
        report: {
          type: "exit",
          generation: 4,
          processId: start.command.processId,
          sequence: 1,
          exitCode: 17,
        },
      }),
    );
    f.adapter.message(
      live.socket,
      runnerFrame.encode({
        type: "exec.report",
        report: {
          type: "closed",
          generation: 4,
          processId: start.command.processId,
          sequence: 2,
        },
      }),
    );
    expect(await child.exited).toEqual({ exitCode: 17, signal: 0, coreDumped: false });
    await child.dispose();
    await binding.quiesce(signal);
    await binding.dispose();
    expect(f.quiesce).toHaveBeenCalledTimes(1);
  });
  it("closes admission on bootstrap cancellation and never reuses its token", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.adapter.connect({ ...f.input, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    const config = await f.launched.promise;
    controller.abort();
    await rejected;
    const late = socketFixture();
    f.adapter.accept(late.socket);
    f.adapter.message(late.socket, f.hello(config));
    expect(late.socket.close).toHaveBeenCalled();
    expect(f.socketHost.connected).not.toHaveBeenCalled();
    expect(f.quiesce).not.toHaveBeenCalled();
    await f.adapter.quiesce(f.input);
  });

  it.each([false, true])(
    "returns on abort while launch is pending (hello accepted: %s)",
    async (accepted) => {
      const launch = deferred<void>();
      const f = fixture(launch.promise);
      const controller = new AbortController();
      const pending = f.adapter.connect({ ...f.input, signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("cancelled");
      const config = await f.launched.promise;
      if (accepted) {
        const early = socketFixture();
        f.adapter.accept(early.socket);
        f.adapter.message(early.socket, f.hello(config));
      }
      controller.abort();
      await rejected;
      await expect(f.adapter.connect(f.input)).rejects.toThrow("already registered");
      const late = socketFixture();
      f.adapter.accept(late.socket);
      f.adapter.message(late.socket, f.hello(config));
      expect(late.socket.close).toHaveBeenCalledWith(1008, "Command Runner frame rejected");
      expect(f.socketHost.connected).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(f.socketHost.generationEnded).not.toHaveBeenCalled();
      launch.reject(new Error("Late provider failure"));
      f.quiesce.mockRejectedValueOnce(new Error("Native closure is unknown"));
      await expect(f.adapter.quiesce(f.input)).rejects.toThrow("unknown");
      await expect(f.adapter.connect(f.input)).rejects.toThrow("already registered");
      await f.adapter.quiesce(f.input);
      expect(f.quiesce).toHaveBeenCalledTimes(2);
    },
  );

  it("reclaims idle hello slots without closing an authenticated connection", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const pending = f.adapter.connect(f.input);
      const config = await f.launched.promise;
      const sockets = Array.from({ length: 32 }, socketFixture);
      for (const { socket } of sockets) f.adapter.accept(socket);
      const overflow = socketFixture();
      f.adapter.accept(overflow.socket);
      expect(overflow.socket.close).toHaveBeenCalledWith(
        1008,
        "Command Runner socket capacity reached",
      );
      const live = sockets[0]!;
      f.adapter.message(live.socket, f.hello(config));
      const connection = await pending;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(live.socket.close).not.toHaveBeenCalled();
      for (const { socket } of sockets.slice(1)) {
        expect(socket.close).toHaveBeenCalledWith(1008, "Command Runner hello timed out");
      }
      const next = socketFixture();
      f.adapter.accept(next.socket);
      expect(next.socket.accept).toHaveBeenCalledTimes(1);
      f.adapter.closed(next.socket);
      await f.adapter.quiesce(f.input);
      await connection.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects agent capabilities and stale process reports without granting native closure", async () => {
    const f = fixture();
    const pending = f.adapter.connect(f.input);
    const config = await f.launched.promise;
    const agent = socketFixture();
    f.adapter.accept(agent.socket);
    f.adapter.message(agent.socket, f.hello(config, { steers: true }));
    expect(agent.socket.close).toHaveBeenCalled();
    expect(f.socketHost.connected).not.toHaveBeenCalled();
    const live = socketFixture();
    f.adapter.accept(live.socket);
    f.adapter.message(live.socket, f.hello(config));
    const connection = await pending;
    f.adapter.message(
      live.socket,
      runnerFrame.encode({
        type: "exec.report",
        report: {
          type: "exit",
          generation: 5,
          processId: "wrong",
          sequence: 1,
          exitCode: 0,
        },
      }),
    );
    expect(f.socketHost.report).not.toHaveBeenCalled();
    expect(f.socketHost.disconnected).toHaveBeenCalledTimes(1);
    expect(f.socketHost.generationEnded).not.toHaveBeenCalled();
    await expect(connection.lease.acquire(signal)).rejects.toThrow("unavailable");
    await f.adapter.quiesce(f.input);
    await connection.dispose();
  });
});
