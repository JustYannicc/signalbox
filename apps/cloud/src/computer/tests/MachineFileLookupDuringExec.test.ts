import { describe, expect, it, vi } from "vite-plus/test";
import type { ExecCommand } from "@signalbox/runner-protocol/ExecProtocol";
import type {
  MachineFilesRequest,
  MachineFilesResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import type { MachineHandle } from "../Machine.ts";
import type { MachineFileSourceAttestation } from "../MachineFilesPort.ts";
import {
  createRunnerMachineRuntime,
  type MachineRunnerTransport,
} from "../RunnerMachineRuntime.ts";

const machine: MachineHandle = { id: "machine-1", generation: 4, release: async () => undefined };
const owner = { operationId: "command-1", machineId: machine.id, generation: machine.generation };
type RunnerExecSocketHost = Parameters<MachineRunnerTransport["connect"]>[0]["socketHost"];

const command = {
  executable: "/usr/bin/probe",
  argv: ["probe"],
  cwd: "/workspace",
  env: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("machine file lookup during exec", () => {
  it("serves live lookup while the process holds the exclusive command lease", async () => {
    const started = deferred<Extract<ExecCommand, { type: "start" }>>();
    const socket = {} as WebSocket;
    let leaseHeld = false;
    let socketHost!: RunnerExecSocketHost;
    let state = { generation: 4, pristine: true };
    const source: MachineFileSourceAttestation = {
      current: () => state,
      markExecuted: async (generation) => {
        if (generation !== state.generation) throw new Error("stale generation");
        state = { ...state, pristine: false };
      },
    };
    const release = vi.fn(async () => {
      leaseHeld = false;
    });
    const runtime = createRunnerMachineRuntime(
      {
        connect: async (input) => {
          socketHost = input.socketHost;
          socketHost.connected(socket, {
            generation: 4,
            connection: 2,
            protocolVersion: 8,
            exec: true,
            machineFileLookup: true,
            send(message) {
              if (message.type === "machine.files.request") {
                expect(leaseHeld).toBe(true);
                const result: MachineFilesResult = {
                  type: "machine.files.result",
                  generation: 4,
                  requestId: message.requestId,
                  outcome: {
                    status: "ok",
                    results: [
                      {
                        id: "stat-1",
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
                      },
                    ],
                  },
                };
                socketHost.machineFileResult?.(socket, 4, 2, result);
                return;
              }
              if (message.type === "exec.command" && message.command.type === "start")
                started.resolve(message.command);
            },
          });
          return {
            owner,
            lease: {
              acquire: async () => {
                if (leaseHeld) throw new Error("The command lease is exclusive");
                leaseHeld = true;
                return { generation: 4, connection: 2, release };
              },
            },
            dispose: async () => undefined,
          };
        },
        quiesce: async () => ({ ...owner, closed: true }),
      },
      { machineFileSource: () => source },
    );
    const signal = new AbortController().signal;
    const binding = await runtime.attach({
      operationId: owner.operationId,
      machine,
      signal,
      workspace: { canonicalCwd: async () => command.cwd },
      policy: { authorize: async () => undefined },
    });
    const spawning = binding.spawn(command, signal);
    const start = await started.promise;

    const lookup = await binding.machineFiles.lookup(
      { generation: 4, operations: [{ id: "stat-1", op: "stat", path: "/usr/bin/tool" }] },
      signal,
    );
    expect(lookup.results).toMatchObject([{ id: "stat-1", op: "stat", stat: { type: "file" } }]);
    expect(leaseHeld).toBe(true);

    socketHost.report(socket, 4, 2, {
      type: "ack",
      operation: "start",
      generation: 4,
      processId: start.processId,
      requestId: start.requestId,
      applied: false,
      error: { code: "process_error", message: "fixture stopped after lookup" },
    });
    await expect(spawning).rejects.toThrow("Runner rejected process command (process_error)");
    expect(leaseHeld).toBe(false);
    await binding.quiesce(signal);
    await binding.dispose();
  });

  it("keeps metadata lookups attached after closed releases the process lease", async () => {
    const started = deferred<Extract<ExecCommand, { type: "start" }>>();
    const requestStarted = deferred<MachineFilesRequest>();
    const released = deferred<void>();
    const socket = {} as WebSocket;
    const leaseStatesAtLookup: boolean[] = [];
    let leaseHeld = false;
    let ownerDisposed = false;
    let holdNextRequest = true;
    let socketHost!: RunnerExecSocketHost;
    const source: MachineFileSourceAttestation = {
      current: () => ({ generation: 4, pristine: false }),
      markExecuted: async () => undefined,
    };
    const respond = (request: MachineFilesRequest) => {
      const operation = request.operations[0];
      if (operation?.op !== "stat") throw new Error("Expected one stat request");
      const result: MachineFilesResult = {
        type: "machine.files.result",
        generation: 4,
        requestId: request.requestId,
        outcome: {
          status: "ok",
          results: [
            {
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
            },
          ],
        },
      };
      socketHost.machineFileResult?.(socket, 4, 2, result);
    };
    const runtime = createRunnerMachineRuntime(
      {
        connect: async (input) => {
          socketHost = input.socketHost;
          socketHost.connected(socket, {
            generation: 4,
            connection: 2,
            protocolVersion: 8,
            exec: true,
            machineFileLookup: true,
            send(message) {
              if (message.type === "machine.files.request") {
                leaseStatesAtLookup.push(leaseHeld);
                if (holdNextRequest) {
                  holdNextRequest = false;
                  requestStarted.resolve(message);
                } else {
                  respond(message);
                }
                return;
              }
              if (message.command.type !== "start") return;
              started.resolve(message.command);
              socketHost.report(socket, 4, 2, {
                type: "ack",
                operation: "start",
                generation: 4,
                processId: message.command.processId,
                requestId: message.command.requestId,
                applied: true,
              });
            },
          });
          return {
            owner,
            lease: {
              acquire: async () => {
                leaseHeld = true;
                return {
                  generation: 4,
                  connection: 2,
                  release: async () => {
                    leaseHeld = false;
                    released.resolve();
                  },
                };
              },
            },
            dispose: async () => {
              ownerDisposed = true;
            },
          };
        },
        quiesce: async () => ({ ...owner, closed: true }),
      },
      { machineFileSource: () => source },
    );
    const signal = new AbortController().signal;
    const binding = await runtime.attach({
      operationId: owner.operationId,
      machine,
      signal,
      workspace: { canonicalCwd: async () => command.cwd },
      policy: { authorize: async () => undefined },
    });
    try {
      const spawning = binding.spawn(command, signal);
      const start = await started.promise;
      const child = await spawning;
      const lookup = binding.machineFiles.lookup(
        { generation: 4, operations: [{ id: "refresh-1", op: "stat", path: "/usr/bin/tool" }] },
        signal,
      );
      const request = await requestStarted.promise;
      const wrappedExit = child.exited.then(async (exit) => {
        await lookup;
        return exit;
      });
      let wrappedExitSettled = false;
      void wrappedExit.then(() => {
        wrappedExitSettled = true;
      });

      socketHost.report(socket, 4, 2, {
        type: "exit",
        generation: 4,
        processId: start.processId,
        sequence: 1,
        exitCode: 0,
      });
      await expect(child.exited).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      socketHost.report(socket, 4, 2, {
        type: "closed",
        generation: 4,
        processId: start.processId,
        sequence: 2,
      });
      await released.promise;

      expect(leaseHeld).toBe(false);
      expect(ownerDisposed).toBe(false);
      expect(binding.owner).toEqual(owner);
      expect(binding.machineFiles.current()).toMatchObject({ generation: 4, pristine: false });
      await Promise.resolve();
      expect(wrappedExitSettled).toBe(false);
      respond(request);
      await expect(wrappedExit).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(wrappedExitSettled).toBe(true);

      const afterClose = await binding.machineFiles.lookup(
        { generation: 4, operations: [{ id: "refresh-2", op: "stat", path: "/usr/bin/other" }] },
        signal,
      );
      expect(afterClose.results).toMatchObject([{ id: "refresh-2", op: "stat" }]);
      expect(leaseStatesAtLookup).toEqual([true, false]);
    } finally {
      await binding.dispose();
    }
    expect(ownerDisposed).toBe(true);
  });
});
