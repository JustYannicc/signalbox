import { describe, expect, it, vi } from "vite-plus/test";
import type { ExecCommand, ExecReport } from "@signalbox/runner-protocol/ExecProtocol";
import type { KernelCommand } from "../../kernel/KernelCommandForwarder.ts";
import {
  makeThreadExecForwarder,
  type ThreadExecForwarder,
  type ThreadExecForwarderOptions,
} from "../ThreadExecForwarder.ts";

const command: KernelCommand = {
  executable: "node",
  argv: ["node", "-e", "process.exit(7)"],
  cwd: "/workspace",
  env: { PATH: "/usr/bin" },
};

type Deferred<A> = { readonly promise: Promise<A>; readonly resolve: (value: A) => void };

const deferred = <A>(): Deferred<A> => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function setup(
  options: ThreadExecForwarderOptions = {
    lease: {
      acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
    },
    workspace: { canonicalCwd: async () => "/workspace" },
    policy: { authorize: async () => undefined },
  },
) {
  const socket = {} as WebSocket;
  const frames: ExecCommand[] = [];
  const startSent = deferred<Extract<ExecCommand, { type: "start" }>>();
  const commandWaiters = new Map<ExecCommand["type"], Array<Deferred<ExecCommand>>>();
  let forwarder!: ThreadExecForwarder;
  forwarder = makeThreadExecForwarder(options);
  forwarder.socketHost.connected(socket, {
    generation: 4,
    connection: 2,
    protocolVersion: 8,
    exec: true,
    send: ({ command: sent }) => {
      frames.push(sent);
      const waiters = commandWaiters.get(sent.type);
      waiters?.shift()?.resolve(sent);
      if (sent.type === "start") startSent.resolve(sent);
    },
  });
  const report = (value: ExecReport) => forwarder.report(socket, 4, 2, value);
  const acknowledge = (sent: ExecCommand, applied = true) => {
    report({
      type: "ack",
      generation: 4,
      processId: sent.processId,
      operation: sent.type,
      ...("writeId" in sent ? { writeId: sent.writeId } : { requestId: sent.requestId }),
      applied,
      ...(applied ? {} : { error: { code: "process_error", message: "Rejected by Runner" } }),
    });
  };
  const waitForCommand = (type: ExecCommand["type"]) => {
    const pending = deferred<ExecCommand>();
    const waiters = commandWaiters.get(type) ?? [];
    waiters.push(pending);
    commandWaiters.set(type, waiters);
    return pending.promise;
  };
  return { socket, frames, startSent, waitForCommand, forwarder, report, acknowledge };
}

describe("ThreadExecForwarder", () => {
  it("requires a negotiated Runner and never emits a command for an older Runner", async () => {
    const withoutLease = setup({});
    await expect(
      withoutLease.forwarder.spawn(command, new AbortController().signal),
    ).rejects.toMatchObject({
      name: "KernelForwardingUnavailable",
      code: "RUNNER_NOT_READY",
    });

    const old = setup({
      lease: {
        acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
      },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
    });
    old.forwarder.socketHost.connected(old.socket, {
      generation: 4,
      connection: 3,
      protocolVersion: 7,
      exec: false,
      send: ({ command: sent }) => old.frames.push(sent),
    });
    await expect(old.forwarder.spawn(command, new AbortController().signal)).rejects.toMatchObject({
      code: "RUNNER_NOT_READY",
    });
    expect(old.frames).toEqual([]);
  });

  it("stops before the first Runner frame until workspace and policy proofs exist", async () => {
    const fixture = setup({
      lease: {
        acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
      },
    });
    await expect(
      fixture.forwarder.spawn(command, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "WORKSPACE_NOT_READY",
    });
    expect(fixture.frames).toEqual([]);

    const policyMissing = setup({
      lease: {
        acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
      },
      workspace: { canonicalCwd: async () => "/workspace" },
    });
    await expect(
      policyMissing.forwarder.spawn(command, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "POLICY_NOT_READY",
    });
    expect(policyMissing.frames).toEqual([]);
  });

  it("rejects a cwd mapping until it matches the requested workspace path", async () => {
    const authorize = vi.fn(async () => undefined);
    const fixture = setup({
      lease: {
        acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
      },
      workspace: { canonicalCwd: async () => "/workspace/project" },
      policy: { authorize },
    });
    await expect(
      fixture.forwarder.spawn(command, new AbortController().signal),
    ).rejects.toMatchObject({
      name: "KernelForwardingUnavailable",
      code: "WORKSPACE_NOT_READY",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(fixture.frames).toEqual([]);
  });

  it("preserves workspace and policy failures from an installed capability", async () => {
    const workspaceFailure = setup({
      lease: {
        acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
      },
      workspace: {
        canonicalCwd: async () => {
          throw new Error("file does not exist");
        },
      },
      policy: { authorize: async () => undefined },
    });
    await expect(
      workspaceFailure.forwarder.spawn(command, new AbortController().signal),
    ).rejects.toThrow("file does not exist");
    expect(workspaceFailure.frames).toEqual([]);

    const policyFailure = setup({
      lease: {
        acquire: async () => ({ generation: 4, connection: 2, release: async () => undefined }),
      },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: {
        authorize: async () => {
          throw new Error("command is denied");
        },
      },
    });
    await expect(
      policyFailure.forwarder.spawn(command, new AbortController().signal),
    ).rejects.toThrow("command is denied");
    expect(policyFailure.frames).toEqual([]);
  });

  it("routes acked stdin and signal operations, keeps binary streams separate, and waits for stream close after exit", async () => {
    const leaseReleased = deferred<void>();
    const released = vi.fn(async () => leaseReleased.resolve());
    const fixture = setup({
      lease: { acquire: async () => ({ generation: 4, connection: 2, release: released }) },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
    });
    const spawnPromise = fixture.forwarder.spawn(command, new AbortController().signal);
    const start = await fixture.startSent.promise;
    expect(start).toMatchObject({
      executable: "node",
      argv: command.argv,
      cwd: "/workspace",
      env: command.env,
    });
    fixture.acknowledge(start);
    const child = await spawnPromise;

    const writer = child.stdin.getWriter();
    const inputReady = fixture.waitForCommand("stdin.write");
    const write = writer.write(new Uint8Array([0, 255, 1]));
    const input = await inputReady;
    expect(input).toMatchObject({ type: "stdin.write", dataBase64: "AP8B" });
    let writeSettled = false;
    void write.then(() => {
      writeSettled = true;
    });
    await Promise.resolve();
    expect(writeSettled).toBe(false);
    fixture.acknowledge(input);
    await write;

    const signalReady = fixture.waitForCommand("signal");
    const signalResult = child.signal(15);
    const signalCommand = await signalReady;
    expect(signalCommand).toMatchObject({ type: "signal", signal: 15 });
    let signalSettled = false;
    void signalResult.then(() => {
      signalSettled = true;
    });
    await Promise.resolve();
    expect(signalSettled).toBe(false);
    fixture.acknowledge(signalCommand);
    await expect(signalResult).resolves.toMatchObject({ status: "ok" });

    const stdout = child.stdout.getReader();
    const stderr = child.stderr.getReader();
    fixture.report({
      type: "exit",
      generation: 4,
      processId: start.processId,
      sequence: 1,
      exitCode: 7,
    });
    await expect(child.exited).resolves.toEqual({ exitCode: 7, signal: 0, coreDumped: false });
    fixture.report({
      type: "output",
      generation: 4,
      processId: start.processId,
      sequence: 2,
      stream: "stdout",
      dataBase64: "AP9B",
    });
    fixture.report({
      type: "output",
      generation: 4,
      processId: start.processId,
      sequence: 3,
      stream: "stderr",
      dataBase64: "QgA=",
    });
    await expect(stdout.read()).resolves.toEqual({
      done: false,
      value: new Uint8Array([0, 255, 65]),
    });
    await expect(stderr.read()).resolves.toEqual({ done: false, value: new Uint8Array([66, 0]) });

    let reachedEof = false;
    const stdoutEof = stdout.read().then((result) => {
      reachedEof = true;
      return result;
    });
    await Promise.resolve();
    expect(reachedEof).toBe(false);
    expect(released).not.toHaveBeenCalled();
    fixture.report({
      type: "closed",
      generation: 4,
      processId: start.processId,
      sequence: 4,
    });
    await expect(stdoutEof).resolves.toEqual({ done: true, value: undefined });
    await expect(stderr.read()).resolves.toEqual({ done: true, value: undefined });
    await leaseReleased.promise;
    expect(released).toHaveBeenCalledOnce();
  });

  it("retains a disconnected generation's lease until its owner confirms termination", async () => {
    const leaseReleased = deferred<void>();
    const released = vi.fn(async () => leaseReleased.resolve());
    const fixture = setup({
      lease: { acquire: async () => ({ generation: 4, connection: 2, release: released }) },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
    });
    const spawnPromise = fixture.forwarder.spawn(command, new AbortController().signal);
    const start = await fixture.startSent.promise;
    fixture.acknowledge(start);
    const child = await spawnPromise;
    const replacement = {} as WebSocket;
    fixture.forwarder.socketHost.connected(replacement, {
      generation: 5,
      connection: 1,
      protocolVersion: 8,
      exec: true,
      send: () => undefined,
    });
    await expect(child.exited).rejects.toThrow("Runner connection was replaced");
    expect(released).not.toHaveBeenCalled();
    fixture.report({
      type: "output",
      generation: 4,
      processId: start.processId,
      sequence: 1,
      stream: "stdout",
      dataBase64: "QQ==",
    });
    expect(released).not.toHaveBeenCalled();
    fixture.forwarder.generationEnded(4);
    await leaseReleased.promise;
    expect(released).toHaveBeenCalledOnce();
  });

  it("retains the child and lease after rejected cancellation and retries cleanup", async () => {
    const released = vi.fn(async () => undefined);
    const fixture = setup({
      lease: { acquire: async () => ({ generation: 4, connection: 2, release: released }) },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
    });
    const spawning = fixture.forwarder.spawn(command, new AbortController().signal);
    const start = await fixture.startSent.promise;
    fixture.acknowledge(start);
    const child = await spawning;

    const firstCancel = fixture.waitForCommand("cancel");
    const firstDisposal = fixture.forwarder.dispose();
    const rejected = expect(firstDisposal).rejects.toThrow("Runner process cleanup failed");
    fixture.acknowledge(await firstCancel, false);
    await rejected;
    expect(released).not.toHaveBeenCalled();

    const retryCancel = fixture.waitForCommand("cancel");
    const retry = fixture.forwarder.dispose();
    fixture.acknowledge(await retryCancel);
    expect(released).not.toHaveBeenCalled();
    fixture.report({
      type: "exit",
      generation: 4,
      processId: start.processId,
      sequence: 1,
      exitCode: 0,
    });
    fixture.report({ type: "closed", generation: 4, processId: start.processId, sequence: 2 });
    await retry;
    await child.dispose();
    expect(released).toHaveBeenCalledOnce();
  });

  it("retries a transient Runner lease release failure during disposal", async () => {
    const releaseAttempted = deferred<void>();
    let attempts = 0;
    const released = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        releaseAttempted.resolve();
        throw new Error("temporary release failure");
      }
    });
    const fixture = setup({
      lease: { acquire: async () => ({ generation: 4, connection: 2, release: released }) },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
    });
    const spawnPromise = fixture.forwarder.spawn(command, new AbortController().signal);
    const start = await fixture.startSent.promise;
    fixture.acknowledge(start);
    const child = await spawnPromise;

    fixture.report({
      type: "exit",
      generation: 4,
      processId: start.processId,
      sequence: 1,
      exitCode: 0,
    });
    fixture.report({
      type: "closed",
      generation: 4,
      processId: start.processId,
      sequence: 2,
    });
    await expect(child.exited).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });
    await releaseAttempted.promise;
    await fixture.forwarder.dispose();

    expect(released).toHaveBeenCalledTimes(2);
  });

  it("preserves signal exit status and waits for cancel acknowledgement plus closed before disposal", async () => {
    const leaseReleased = deferred<void>();
    const fixture = setup({
      lease: {
        acquire: async () => ({
          generation: 4,
          connection: 2,
          release: async () => leaseReleased.resolve(),
        }),
      },
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
    });
    const spawnPromise = fixture.forwarder.spawn(command, new AbortController().signal);
    const start = await fixture.startSent.promise;
    fixture.acknowledge(start);
    const child = await spawnPromise;

    const cancelReady = fixture.waitForCommand("cancel");
    let disposed = false;
    const disposal = child.dispose().then(() => {
      disposed = true;
    });
    const cancel = await cancelReady;
    await Promise.resolve();
    expect(disposed).toBe(false);
    fixture.acknowledge(cancel);
    await Promise.resolve();
    expect(disposed).toBe(false);

    fixture.report({
      type: "exit",
      generation: 4,
      processId: start.processId,
      sequence: 1,
      signal: 15,
      coreDumped: true,
    });
    await expect(child.exited).resolves.toEqual({ exitCode: 0, signal: 15, coreDumped: true });
    fixture.report({
      type: "closed",
      generation: 4,
      processId: start.processId,
      sequence: 2,
    });
    await disposal;
    await leaseReleased.promise;
    expect(disposed).toBe(true);
  });
});
