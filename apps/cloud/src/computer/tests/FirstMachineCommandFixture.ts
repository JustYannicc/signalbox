import { expect, vi } from "vite-plus/test";
import type { ExecCommand } from "@signalbox/runner-protocol/ExecProtocol";
import type {
  MachineFileOperationResult,
  MachineFileStat,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import type { MachineFileSourceState, MachineFilesPort } from "../MachineFilesPort.ts";
import { createProductComputer } from "../ProductComputer.ts";
import {
  createRunnerMachineRuntime,
  type MachineRunnerTransport,
} from "../RunnerMachineRuntime.ts";
import type { MachineCommandRuntimeBinding } from "../MachineWorkspace.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { sqliteFixture } from "../sqliteTesting.ts";

export function firstCommandFixture(
  attached: boolean,
  options: {
    readonly omitGeneration?: boolean;
    readonly replaceGeneration?: boolean;
    readonly failDirtyPersist?: boolean;
  } = {},
) {
  const inventory = machineInventoryFixture([
    { path: "/usr/bin/uname", mode: 0o755, uid: 0, gid: 0 },
  ]);
  const machine = { id: "first-machine", generation: 1, release: async () => undefined };
  const owner = { operationId: "first-command", machineId: machine.id, generation: 1 };
  const socket = {} as WebSocket;
  let socketHost!: Parameters<MachineRunnerTransport["connect"]>[0]["socketHost"];
  let binding: MachineCommandRuntimeBinding | undefined;
  let state: MachineFileSourceState = {
    generation: null,
    generationAbsent: true,
    imageDigest: inventory.imageDigest,
    pristine: true,
  };
  const starts: Array<Extract<ExecCommand, { type: "start" }>> = [];
  const started = Promise.withResolvers<void>();
  const lookupGenerations: number[] = [];
  const lookupFailures: unknown[] = [];
  const machineStat = (entry: (typeof inventory.entries)[number]): MachineFileStat => ({
    ...entry,
    mode: entry.mode | (entry.type === "directory" ? 0o40000 : 0o100000),
    dev: "1",
    ino: String(inventory.entries.indexOf(entry) + 1),
  });
  const release = vi.fn(async () => undefined);
  const runtime = createRunnerMachineRuntime(
    {
      async connect(input) {
        state = { generation: 1, imageDigest: inventory.imageDigest, pristine: true };
        socketHost = input.socketHost;
        socketHost.connected(socket, {
          generation: 1,
          connection: 1,
          protocolVersion: 8,
          exec: true,
          machineFileLookup: true,
          send(message) {
            if (message.type === "machine.files.request") {
              lookupGenerations.push(message.generation);
              const results = message.operations.map((operation): MachineFileOperationResult => {
                const entry = inventory.entries.find(({ path }) => path === operation.path);
                if (entry === undefined)
                  return {
                    id: operation.id,
                    op: operation.op,
                    error: { code: "ENOENT", message: "Path is absent from this machine" },
                  };
                if (operation.op === "readdir")
                  return {
                    id: operation.id,
                    op: "readdir",
                    entries: inventory.entries
                      .filter(
                        ({ path }) =>
                          path !== "/" &&
                          (path.slice(0, path.lastIndexOf("/")) || "/") === operation.path,
                      )
                      .map((child) => ({
                        name: child.path.slice(child.path.lastIndexOf("/") + 1),
                        type: child.type,
                        ...(operation.withStat ? { stat: machineStat(child) } : {}),
                      })),
                    nextCursor: null,
                  };
                if (operation.op !== "stat" && operation.op !== "lstat")
                  throw new Error(`Unexpected machine operation: ${operation.op}`);
                return { id: operation.id, op: operation.op, stat: machineStat(entry) };
              });
              socketHost.machineFileResult?.(socket, 1, 1, {
                type: "machine.files.result",
                generation: 1,
                requestId: message.requestId,
                outcome: { status: "ok", results },
              });
              return;
            }
            const command = message.command;
            if (command.type === "start") {
              expect(state.pristine).toBe(false);
              starts.push(command);
              started.resolve();
            }
            socketHost.report(socket, 1, 1, {
              type: "ack",
              generation: 1,
              operation: command.type,
              processId: command.processId,
              ...(command.type === "stdin.write"
                ? { writeId: command.writeId }
                : { requestId: command.requestId }),
              applied: true,
            });
          },
        });
        return {
          owner,
          lease: { acquire: async () => ({ generation: 1, connection: 1, release }) },
          dispose: async () => undefined,
        };
      },
      quiesce: async () => ({ ...owner, closed: true }),
    },
    {
      machineFileSource: () => ({
        current: () => state,
        async markExecuted(generation) {
          if (generation !== state.generation) throw new Error("Stale machine generation");
          if (options.failDirtyPersist) throw new Error("Dirty transition could not be persisted");
          state = { ...state, pristine: false };
        },
      }),
    },
  );
  const signal = new AbortController().signal;
  const attach = async () => {
    binding ??= await runtime.attach({
      operationId: owner.operationId,
      machine,
      workspace: { canonicalCwd: async () => "/workspace" },
      policy: { authorize: async () => undefined },
      signal,
    });
    return binding;
  };
  const files: MachineFilesPort = {
    current: () => binding?.machineFiles.current() ?? state,
    markExecuted: async (generation) => {
      if (!binding) throw new Error("Machine is not attached");
      await binding.machineFiles.markExecuted(generation);
    },
    lookup: async (input, lookupSignal) => {
      if (!binding) throw new Error("Machine is not attached");
      try {
        return await binding.machineFiles.lookup(input, lookupSignal);
      } catch (error) {
        lookupFailures.push(error);
        throw error;
      }
    },
  };
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  createNodeFs(filesystem).fs.mkdirSync("/workspace");
  const wakes = new KernelWakeRegistry();
  const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
  const open = () =>
    createProductComputer({
      threadId: "first-machine-command",
      filesystem,
      wakes,
      capacity: new ChildWorkerCapacity(2, {
        owner: "test/first-machine-command",
        RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      }),
      loader: {
        run: async () => {
          throw new Error("uname must use the machine transport");
        },
      },
      programs: {
        bash: code,
        busyboxCat: code,
        busyboxApplets: code,
        productBusyboxApplets: code,
        ripgrep: code,
        git: code,
        sed: code,
        jq: code,
        ugrep: code,
        coreutils: Object.fromEntries(
          CHILD_COREUTILS_COMMANDS.map((name) => [name, code]),
        ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], typeof code>,
      },
      machineInventory: inventory,
      machine: () => ({
        files,
        spawn: async (command, callerSignal) => {
          const child = await (await attach()).spawn(command, callerSignal);
          if (options.replaceGeneration) state = { ...state, generation: 2 };
          if (options.omitGeneration)
            return {
              stdin: child.stdin,
              stdout: child.stdout,
              stderr: child.stderr,
              exited: child.exited,
              signal: child.signal,
              dispose: child.dispose,
            };
          return child;
        },
      }),
      signal,
    });
  return {
    attach: attached ? attach : async () => undefined,
    open,
    files,
    starts,
    lookupGenerations,
    lookupFailures,
    release,
    async finish() {
      await started.promise;
      const start = starts[0];
      if (!start) throw new Error("No machine command was sent");
      socketHost.report(socket, 1, 1, {
        type: "output",
        generation: 1,
        processId: start.processId,
        sequence: 1,
        stream: "stdout",
        dataBase64: "TGludXgK",
      });
      socketHost.report(socket, 1, 1, {
        type: "exit",
        generation: 1,
        processId: start.processId,
        sequence: 2,
        exitCode: 0,
      });
      socketHost.report(socket, 1, 1, {
        type: "closed",
        generation: 1,
        processId: start.processId,
        sequence: 3,
      });
    },
    async close() {
      if (binding) {
        await binding.quiesce(signal);
        await binding.dispose();
      }
      wakes.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}
