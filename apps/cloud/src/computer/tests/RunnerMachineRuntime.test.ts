import { describe, expect, it, vi } from "vite-plus/test";
import type { ExecCommand } from "@signalbox/runner-protocol/ExecProtocol";
import type { MachineHandle } from "../Machine.ts";
import type { RunnerExecSocketHost } from "../../thread/ThreadExecForwarder.ts";
import {
  createRunnerMachineRuntime,
  type MachineRunnerTransport,
} from "../RunnerMachineRuntime.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const machine: MachineHandle = { id: "exact-vm", generation: 4, release: async () => undefined };
const owner = { operationId: "command-1", machineId: machine.id, generation: machine.generation };
const command = {
  executable: "/usr/bin/probe",
  argv: ["custom argv0", "", "雪"],
  cwd: "/workspace/project with spaces",
  env: { EXACT: "value", EMPTY: "" },
};

function fixture() {
  const sent: ExecCommand[] = [];
  const release = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  const connect = vi.fn<MachineRunnerTransport["connect"]>(async ({ socketHost }) => {
    const socket = {} as WebSocket;
    socketHost.connected(socket, {
      generation: 4,
      connection: 2,
      protocolVersion: 8,
      exec: true,
      send: ({ command: frame }) => {
        sent.push(frame);
        if (frame.type === "start")
          socketHost.report(socket, 4, 2, {
            type: "ack",
            operation: "start",
            generation: 4,
            processId: frame.processId,
            requestId: frame.requestId,
            applied: false,
            error: { code: "process_error", message: "Native start rejected before creation" },
          });
      },
    });
    return {
      owner,
      lease: { acquire: async () => ({ generation: 4, connection: 2, release }) },
      dispose: disconnect,
    };
  });
  const quiesce = vi.fn<MachineRunnerTransport["quiesce"]>(async () => ({
    ...owner,
    closed: true,
  }));
  const runtime = createRunnerMachineRuntime({ connect, quiesce });
  const input = {
    operationId: owner.operationId,
    machine,
    signal: new AbortController().signal,
    workspace: { canonicalCwd: async () => command.cwd },
    policy: { authorize: async () => undefined },
  };
  return { runtime, input, connect, quiesce, sent, release, disconnect };
}

describe("RunnerMachineRuntime", () => {
  it("retains an uncertain start lease until exact provider closure is verified", async () => {
    const started = deferred<Extract<ExecCommand, { type: "start" }>>();
    const release = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const socket = {} as WebSocket;
    let socketHost!: RunnerExecSocketHost;
    const quiesce = vi.fn<MachineRunnerTransport["quiesce"]>(async () => ({
      ...owner,
      closed: true,
    }));
    quiesce.mockResolvedValueOnce({ ...owner, generation: 5, closed: true });
    const runtime = createRunnerMachineRuntime({
      connect: async (input) => {
        socketHost = input.socketHost;
        socketHost.connected(socket, {
          generation: 4,
          connection: 2,
          protocolVersion: 8,
          exec: true,
          send: ({ command: frame }) => {
            if (frame.type === "start") started.resolve(frame);
          },
        });
        return {
          owner,
          lease: { acquire: async () => ({ generation: 4, connection: 2, release }) },
          dispose: disconnect,
        };
      },
      quiesce,
    });
    const input = fixture().input;
    const binding = await runtime.attach(input);
    const result = binding.spawn(command, input.signal);
    const frame = await started.promise;
    socketHost.report(socket, 4, 2, {
      type: "ack",
      operation: "start",
      generation: 4,
      processId: frame.processId,
      requestId: frame.requestId,
      applied: true,
    });
    socketHost.disconnected(socket, 4, 2);
    const child = await result;
    await expect(child.exited).rejects.toThrow("connection closed");
    expect(release).not.toHaveBeenCalled();
    await expect(binding.quiesce(input.signal)).rejects.toThrow("ownership does not match");
    expect(release).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    await binding.quiesce(input.signal);
    await binding.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("forwards the exact command once through the existing non-PTY protocol", async () => {
    const f = fixture();
    const binding = await f.runtime.attach(f.input);
    await expect(binding.spawn(command, f.input.signal)).rejects.toThrow("process_error");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ type: "start", ...command, generation: machine.generation });
    await expect(binding.spawn(command, f.input.signal)).rejects.toThrow("admission is closed");
    await binding.quiesce(f.input.signal);
    await binding.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not infer closure or detach the connection after a failed provider attestation", async () => {
    const f = fixture();
    f.quiesce.mockRejectedValueOnce(new Error("Native process state is unknown"));
    const binding = await f.runtime.attach(f.input);
    await expect(binding.quiesce(f.input.signal)).rejects.toThrow("state is unknown");
    expect(f.disconnect).not.toHaveBeenCalled();
    await expect(binding.spawn(command, f.input.signal)).rejects.toThrow("admission is closed");
    await expect(binding.quiesce(f.input.signal)).resolves.toEqual({ ...owner, closed: true });
    await binding.dispose();
    expect(f.quiesce).toHaveBeenCalledTimes(2);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects an accepted connection attesting a different operation", async () => {
    const f = fixture();
    f.connect.mockImplementationOnce(async () => ({
      owner: { ...owner, operationId: "another-command" },
      lease: { acquire: async () => ({ generation: 4, connection: 2, release: f.release }) },
      dispose: f.disconnect,
    }));
    await expect(f.runtime.attach(f.input)).rejects.toThrow("ownership does not match");
    expect(f.sent).toEqual([]);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rebinds only a settlement port and retries invalid generation proof without spawning", async () => {
    const f = fixture();
    f.quiesce.mockResolvedValueOnce({ ...owner, generation: 5, closed: true });
    const binding = await f.runtime.rebind?.(f.input);
    if (!binding) throw new Error("Recovery binding is missing");
    expect("spawn" in binding).toBe(false);
    await expect(binding.dispose()).rejects.toThrow("closure is unverified");
    await expect(binding.quiesce(f.input.signal)).rejects.toThrow("ownership does not match");
    await expect(binding.quiesce(f.input.signal)).resolves.toEqual({ ...owner, closed: true });
    await binding.dispose();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it("prevents a start whose policy finishes after provider closure", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const allow = deferred<void>();
    const binding = await f.runtime.attach({
      ...f.input,
      policy: {
        authorize: async () => {
          entered.resolve();
          await allow.promise;
        },
      },
    });
    const result = binding.spawn(command, f.input.signal).catch((error: unknown) => error);
    await entered.promise;
    await binding.quiesce(f.input.signal);
    allow.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(f.sent).toEqual([]);
    await binding.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
