import { describe, expect, it, vi } from "vite-plus/test";
import type { ExecCommand } from "@signalbox/runner-protocol/ExecProtocol";
import type { MachineFilesResult } from "@signalbox/runner-protocol/MachineFilesProtocol";
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
});
