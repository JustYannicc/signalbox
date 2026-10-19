import { describe, expect, it, vi } from "vite-plus/test";
import {
  EXEC_PROTOCOL_VERSION,
  type ExecCommand,
  type ExecCommandErrorCode,
  type ExecReport,
} from "@signalbox/runner-protocol/ExecProtocol";
import { ThreadExecForwarder } from "../ThreadExecForwarder.ts";

async function fixture() {
  const closeRequest = Promise.withResolvers<ExecCommand>();
  const writeRequest = Promise.withResolvers<ExecCommand>();
  let released = 0;
  let acknowledgeWrites = true;
  const socket = {} as WebSocket;
  let processId = "";
  const forwarder = new ThreadExecForwarder({
    acknowledgementTimeoutMs: 30_000,
    lease: {
      acquire: async () => ({
        generation: 1,
        connection: 1,
        release: async () => {
          released++;
        },
      }),
    },
    workspace: { canonicalCwd: async () => "/workspace" },
    policy: { authorize: async () => undefined },
  });
  const report = (value: ExecReport) => forwarder.socketHost.report(socket, 1, 1, value);
  forwarder.socketHost.connected(socket, {
    generation: 1,
    connection: 1,
    protocolVersion: EXEC_PROTOCOL_VERSION,
    exec: true,
    send({ command }) {
      processId = command.processId;
      if (command.type === "stdin.close") closeRequest.resolve(command);
      else if (command.type === "stdin.write" && !acknowledgeWrites) writeRequest.resolve(command);
      else acknowledge(command);
    },
  });
  function acknowledge(command: ExecCommand, code?: ExecCommandErrorCode) {
    report({
      type: "ack",
      generation: 1,
      processId: command.processId,
      operation: command.type,
      ...("writeId" in command ? { writeId: command.writeId } : { requestId: command.requestId }),
      applied: code === undefined,
      ...(code === undefined ? {} : { error: { code, message: "Controlled rejection" } }),
    });
  }
  const child = await forwarder.spawn(
    { executable: "/bin/bash", argv: ["custom argv0"], cwd: "/workspace", env: {} },
    new AbortController().signal,
  );
  return {
    child,
    closeRequest: closeRequest.promise,
    writeRequest: writeRequest.promise,
    acknowledge,
    released: () => released,
    holdWrites: () => {
      acknowledgeWrites = false;
    },
    finish() {
      report({
        type: "output",
        generation: 1,
        processId,
        sequence: 1,
        stream: "stdout",
        dataBase64: "AP9B",
      });
      report({
        type: "output",
        generation: 1,
        processId,
        sequence: 2,
        stream: "stderr",
        dataBase64: "gAA=",
      });
      report({
        type: "exit",
        generation: 1,
        processId,
        sequence: 3,
        exitCode: 17,
      });
      report({
        type: "closed",
        generation: 1,
        processId,
        sequence: 4,
      });
    },
  };
}

async function read(stream: ReadableStream<Uint8Array>) {
  const bytes: number[] = [];
  for await (const chunk of stream) bytes.push(...chunk);
  return bytes;
}

describe("Runner stdin terminal acknowledgements", () => {
  it("finishes an in-flight close when terminal reports arrive without its acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      const controlled = await fixture();
      const writer = controlled.child.stdin.getWriter();
      await writer.write(new Uint8Array([1]));
      const result = writer.close().then(
        () => "closed",
        (error: unknown) => error,
      );
      await controlled.closeRequest;
      controlled.finish();
      await expect(controlled.child.exited).resolves.toEqual({
        exitCode: 17,
        signal: 0,
        coreDumped: false,
      });
      await controlled.child.dispose();
      await vi.runAllTimersAsync();
      const outcome = await result;
      writer.releaseLock();

      expect(controlled.released()).toBe(1);
      expect(outcome).toBe("closed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes stdin when the native process exits before its close request arrives", async () => {
    const controlled = await fixture();
    const writer = controlled.child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("input\n"));
    const result = writer.close().then(
      () => "closed",
      (error: unknown) => error,
    );
    const request = await controlled.closeRequest;
    controlled.acknowledge(request, "process_exited");
    const outcome = await result;
    expect(controlled.released()).toBe(0);

    controlled.finish();
    await expect(read(controlled.child.stdout)).resolves.toEqual([0, 255, 65]);
    await expect(read(controlled.child.stderr)).resolves.toEqual([128, 0]);
    await expect(controlled.child.exited).resolves.toEqual({
      exitCode: 17,
      signal: 0,
      coreDumped: false,
    });
    await controlled.child.dispose();
    writer.releaseLock();

    expect(controlled.released()).toBe(1);
    expect(outcome).toBe("closed");
  });

  it("still rejects a write when the native process has exited", async () => {
    const controlled = await fixture();
    controlled.holdWrites();
    const writer = controlled.child.stdin.getWriter();
    const result = writer.write(new Uint8Array([1])).catch((error: unknown) => error);
    const request = await controlled.writeRequest;
    controlled.acknowledge(request, "process_exited");
    const outcome = await result;
    expect(controlled.released()).toBe(0);
    controlled.finish();
    await controlled.child.dispose();
    writer.releaseLock();

    expect(outcome).toMatchObject({
      report: { operation: "stdin.write", error: { code: "process_exited" } },
    });
    expect(controlled.released()).toBe(1);
  });

  it("keeps other stdin-close failures visible", async () => {
    const controlled = await fixture();
    const writer = controlled.child.stdin.getWriter();
    const result = writer.close().catch((error: unknown) => error);
    const request = await controlled.closeRequest;
    controlled.acknowledge(request, "process_error");
    const outcome = await result;
    expect(controlled.released()).toBe(0);
    controlled.finish();
    await controlled.child.dispose();
    writer.releaseLock();

    expect(outcome).toMatchObject({
      report: { operation: "stdin.close", error: { code: "process_error" } },
    });
    expect(controlled.released()).toBe(1);
  });
});
