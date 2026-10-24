import { describe, expect, it, vi } from "vite-plus/test";
import type {
  MachineFilesRequest,
  MachineFilesResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";

import { RunnerMachineFileLookupForwarder } from "../MachineFileLookupForwarder.ts";
import type { MachineFileSourceAttestation, MachineFileSourceState } from "../MachineFilesPort.ts";

type RunnerExecConnection = Parameters<RunnerMachineFileLookupForwarder["connected"]>[1];

const statOperation = (id: string) => ({ id, op: "stat" as const, path: "/usr/bin/tool" });

function response(request: MachineFilesRequest): MachineFilesResult {
  return {
    type: "machine.files.result",
    generation: request.generation,
    requestId: request.requestId,
    outcome: {
      status: "ok",
      results: request.operations.map((operation) => ({
        id: operation.id,
        op: "stat",
        stat: {
          mode: 0o100755,
          type: "file",
          size: "12",
          uid: 1000,
          gid: 1000,
          dev: "1",
          ino: "2",
          nlink: "1",
          atimeNs: "1",
          mtimeNs: "2",
          ctimeNs: "3",
          birthtimeNs: "4",
        },
      })),
    },
  };
}

const sourceFixture = () => {
  let state: MachineFileSourceState = { generation: 4, pristine: true };
  const source: MachineFileSourceAttestation = {
    current: () => state,
    markExecuted: vi.fn(async (generation: number) => {
      if (state.generation !== generation) throw new Error("stale machine source");
      state = { ...state, pristine: false };
    }),
  };
  return { source, state: () => state };
};

function connection(
  socket: WebSocket,
  host: RunnerMachineFileLookupForwarder,
  options: {
    readonly machineFileLookup?: boolean;
    readonly onRequest?: (request: MachineFilesRequest) => void;
  } = {},
): RunnerExecConnection {
  return {
    generation: 4,
    connection: 2,
    protocolVersion: 8,
    exec: true,
    machineFileLookup: options.machineFileLookup ?? true,
    send(message) {
      if (message.type !== "machine.files.request") return;
      options.onRequest?.(message);
      queueMicrotask(() => host.socketHost.result(socket, 4, 2, response(message)));
    },
  };
}

describe("RunnerMachineFileLookupForwarder", () => {
  it("returns typed results and persists dirty state before execution", async () => {
    const socket = {} as WebSocket;
    const source = sourceFixture();
    const forwarder = new RunnerMachineFileLookupForwarder({
      source: source.source,
      nextRequestId: () => "files-request-1",
    });
    forwarder.socketHost.connected(socket, connection(socket, forwarder));

    expect(forwarder.current()).toEqual({ generation: 4, pristine: true });
    const result = await forwarder.lookup(
      { generation: 4, operations: [statOperation("stat-1")] },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ generation: 4, results: [{ id: "stat-1", op: "stat" }] });

    await forwarder.markExecuted(4);
    expect(source.source.markExecuted).toHaveBeenCalledWith(4);
    expect(forwarder.current()).toEqual({ generation: 4, pristine: false });
    const reopened = new RunnerMachineFileLookupForwarder({ source: source.source });
    expect(reopened.current()).toEqual({ generation: 4, pristine: false });
    await reopened.dispose();
    await forwarder.dispose();
  });

  it("splits requests at the protocol operation limit", async () => {
    const socket = {} as WebSocket;
    const requests: MachineFilesRequest[] = [];
    const forwarder = new RunnerMachineFileLookupForwarder({
      nextRequestId: (() => {
        let id = 0;
        return () => `files-${++id}`;
      })(),
    });
    forwarder.socketHost.connected(
      socket,
      connection(socket, forwarder, { onRequest: (request) => requests.push(request) }),
    );

    const results = await forwarder.lookup(
      {
        generation: 4,
        operations: Array.from({ length: 65 }, (_, index) => statOperation(`stat-${index}`)),
      },
      new AbortController().signal,
    );
    expect(requests.map((request) => request.operations.length)).toEqual([64, 1]);
    expect(results.results).toHaveLength(65);
    await forwarder.dispose();
  });

  it("fails closed for old runners and preserves a planned cold attestation without a socket", async () => {
    const old = new RunnerMachineFileLookupForwarder({
      nextRequestId: () => "old-runner",
    });
    const oldSocket = {} as WebSocket;
    old.socketHost.connected(oldSocket, connection(oldSocket, old, { machineFileLookup: false }));
    await expect(
      old.lookup(
        { generation: 4, operations: [statOperation("tool")] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "BACKEND_UPGRADE_REQUIRED" });

    const source: MachineFileSourceAttestation = {
      current: () => ({ generation: null, pristine: true }),
      markExecuted: async () => undefined,
    };
    const planned = new RunnerMachineFileLookupForwarder({ source });
    expect(planned.current()).toEqual({ generation: null, pristine: true });
    await expect(
      planned.lookup(
        { generation: 1, operations: [statOperation("tool")] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNNER_NOT_READY" });
    await old.dispose();
    await planned.dispose();
  });

  it("rejects a lifecycle dirty transition that leaves a pristine machine attested", async () => {
    const source: MachineFileSourceAttestation = {
      current: () => ({ generation: 4, pristine: true }),
      markExecuted: async () => undefined,
    };
    const forwarder = new RunnerMachineFileLookupForwarder({ source });
    await expect(forwarder.markExecuted(4)).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
    expect(forwarder.current()).toEqual({ generation: 4, pristine: true });
    await forwarder.dispose();
  });
});
