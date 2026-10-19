import * as Option from "effect/Option";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import type {
  CommitInode,
  FileCommitReceipt,
  FilePersistenceResult,
  FilePersistencePorts,
  ForkCommit,
} from "../../../kernel/FilePersistencePorts.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandExit,
} from "../../../kernel/KernelCommandForwarder.ts";
import type { BaseLease, DriveRef, RecipeHash } from "../../Computer.ts";
import { MachineCommands } from "../../MachineCommands.ts";
import type { Machine, MachineHandle } from "../../Machine.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "../../MachineCommandJournal.ts";
import type {
  MachineCommandRuntime,
  MachineWorkspace,
  MachineWorkspaceMount,
} from "../../MachineWorkspace.ts";

export const machineBefore: ForkCommit = {
  repository: "drive-repository",
  fork: "thread-fork",
  commit: "before-commit",
};

export const machineCommand: KernelCommand = {
  executable: "/usr/bin/tool",
  argv: ["argv0-is-exact", "", "two words", "--unicode=雪"],
  cwd: "/workspace/project with spaces",
  env: { EMPTY: "", TOKEN: "keep=equals", MULTILINE: "a\nb" },
};

export const machineInputPath = "/workspace/source.bin";
export const machineOutputPath = "/workspace/result.bin";
export const machineInputBytes = new Uint8Array([0, 255, 17, 0, 128]);
export const machineOutputBytes = new Uint8Array([255, 0, 65, 10, 13, 128]);

export interface MachineFixtureOptions {
  readonly baseLease?: BaseLease;
  readonly checkpoint?: (operationId: string, signal: AbortSignal) => Promise<ForkCommit>;
  readonly commitFailures?: number;
  readonly journal?: MachineCommandJournal;
  readonly createMachine?: (
    input: Parameters<Machine["create"]>[0],
    signal: AbortSignal,
    handle: MachineHandle,
  ) => Promise<MachineHandle>;
  readonly reconcileMachine?: Machine["reconcile"];
  readonly deleteMachine?: () => Promise<void>;
  readonly releaseBase?: (lease: BaseLease) => Promise<void>;
  readonly runtimeDispose?: () => Promise<void>;
  readonly spawn?: (
    command: KernelCommand,
    signal: AbortSignal,
    fixture: MachineFixture,
  ) => Promise<KernelCommandChild>;
  readonly changes?: () => readonly CommitInode[];
  readonly machine?: Machine;
  readonly runtime?: MachineCommandRuntime;
  readonly workspace?: MachineWorkspace;
  readonly ports?: FilePersistencePorts;
  readonly resume?: MachineWorkspace["resume"];
  readonly rebind?: MachineCommandRuntime["rebind"];
  readonly apply?: (input: {
    readonly before: ForkCommit;
    readonly after: ForkCommit;
    readonly changedInodes: readonly CommitInode[];
    readonly hydration: FilePersistencePorts["hydration"];
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export interface MachineFixture {
  readonly commands: MachineCommands;
  readonly workspace: MachineWorkspace;
  readonly runtime: MachineCommandRuntime;
  readonly mount: MachineWorkspaceMount | undefined;
  readonly events: string[];
  readonly records: MachineCommandRecord[];
  readonly createCalls: Parameters<Machine["create"]>[0][];
  readonly commitAttempts: string[];
  readonly spawnCalls: KernelCommand[];
  readonly ports: FilePersistencePorts;
  readonly memory: ReturnType<typeof createMemoryFilePersistencePorts>;
  readonly child: KernelCommandChild;
  readonly stdinBytes: Uint8Array[];
  readonly recoverySignal: AbortSignal;
  readonly appliedBytes: Uint8Array[];
  readonly hydratedBytes: Uint8Array[];
  readonly policy: Parameters<MachineCommandRuntime["attach"]>[0]["policy"][];
  readonly closeChild: (exit?: KernelCommandExit) => void;
  readonly markOutputWritten: () => void;
  readonly operationIds: string[];
}

const exitStatus: KernelCommandExit = { exitCode: 0, signal: 0, coreDumped: false };
const bytes = (parts: readonly Uint8Array[]) => {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

async function fetchBytes(
  hydration: FilePersistencePorts["hydration"],
  at: ForkCommit,
  path: string,
  signal: AbortSignal,
) {
  const fetched = await hydration.fetch({ at, paths: [path], signal });
  if (fetched.status === "error") throw new Error(fetched.error.message);
  const parts: Uint8Array[] = [];
  for await (const chunk of fetched.value[0]!.chunks) parts.push(chunk);
  return bytes(parts);
}

/** LocalMachineFake only; these tests do not attest to boxd or a real VM. */
export function createMachineFixture(options: MachineFixtureOptions = {}): MachineFixture {
  const events: string[] = [];
  const records: MachineCommandRecord[] = [];
  const createCalls: Parameters<Machine["create"]>[0][] = [];
  const commitAttempts: string[] = [];
  const spawnCalls: KernelCommand[] = [];
  const appliedBytes: Uint8Array[] = [];
  const hydratedBytes: Uint8Array[] = [];
  const policy: MachineFixture["policy"] = [];
  const operationIds: string[] = [];
  const stdinBytes: Uint8Array[] = [];
  const memory = createMemoryFilePersistencePorts();
  let commitFailures = options.commitFailures ?? 0;
  let producedOutput = false;
  memory.seedFile(machineBefore, machineInputPath, machineInputBytes);
  const localPorts: FilePersistencePorts = {
    hydration: memory.hydration,
    commits: {
      async commit(input) {
        events.push("file.commit");
        commitAttempts.push(input.turnId);
        if (commitFailures > 0) {
          commitFailures -= 1;
          return {
            status: "error",
            error: { code: "IO_ERROR", message: "Temporary file commit failure" },
          } satisfies FilePersistenceResult<FileCommitReceipt>;
        }
        return memory.commits.commit(input);
      },
    },
  };
  const ports = options.ports ?? localPorts;

  let resolveExit!: (exit: KernelCommandExit) => void;
  const exited = new Promise<KernelCommandExit>((resolve) => {
    resolveExit = resolve;
  });
  let closed = false;
  let dispose: Promise<void> | undefined;
  const closeChild = (exit = exitStatus) => {
    if (closed) return;
    closed = true;
    events.push("child.closed");
    resolveExit(exit);
  };
  const child: KernelCommandChild = {
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        stdinBytes.push(chunk.slice());
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255, 8]));
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([13, 0, 10]));
        controller.close();
      },
    }),
    exited,
    async signal() {
      return { status: "ok", value: undefined };
    },
    dispose() {
      dispose ??= (async () => {
        events.push("child.dispose");
        closeChild();
      })();
      return dispose;
    },
  };

  const fixture = {
    commands: undefined as unknown as MachineCommands,
    workspace: undefined as unknown as MachineWorkspace,
    runtime: undefined as unknown as MachineCommandRuntime,
    mount: undefined as MachineWorkspaceMount | undefined,
    events,
    records,
    createCalls,
    commitAttempts,
    spawnCalls,
    ports,
    memory,
    child,
    stdinBytes,
    recoverySignal: new AbortController().signal,
    appliedBytes,
    hydratedBytes,
    policy,
    closeChild,
    markOutputWritten: () => {
      producedOutput = true;
    },
    operationIds,
  } satisfies Omit<MachineFixture, "commands"> & { commands: MachineCommands };

  const outputInode: CommitInode = {
    inode: 2n,
    paths: [machineOutputPath],
    removedPaths: [],
    stat: {
      type: "file",
      size: BigInt(machineOutputBytes.byteLength),
      nlink: 1n,
      atimeNs: 0n,
      mtimeNs: 0n,
      ctimeNs: 0n,
    },
    symlinkTarget: null,
    async *readChunks() {
      yield machineOutputBytes.slice(0, 3);
      yield machineOutputBytes.slice(3);
    },
  };
  let machineCreated = false;
  let machineDeleted = false;
  const handle: MachineHandle = {
    id: "local-machine-1",
    generation: 7,
    async release() {
      events.push("machine.delete");
      await options.deleteMachine?.();
      machineDeleted = true;
    },
  };

  const memoryJournal: MachineCommandJournal = {
    async write(record) {
      events.push(`journal:${record.phase}`);
      records.push(structuredClone(record));
    },
    read(operationId) {
      const record = records.toReversed().find((item) => item.operationId === operationId);
      return record ? structuredClone(record) : undefined;
    },
    pending() {
      const latest = new Map<string, MachineCommandRecord>();
      for (const record of records) latest.set(record.operationId, record);
      return [...latest.values()].filter((record) => record.phase !== "complete");
    },
  };

  let lastMount: MachineWorkspaceMount | undefined;
  const localWorkspace: MachineWorkspace = {
    async checkpoint(operationId: string, _signal: AbortSignal) {
      operationIds.push(operationId.replace(/:before$/, ""));
      events.push("checkpoint");
      return options.checkpoint?.(operationId, _signal) ?? machineBefore;
    },
    async prepare(
      _machine: MachineHandle,
      at: ForkCommit,
      hydration: FilePersistencePorts["hydration"],
      signal: AbortSignal,
    ) {
      events.push("prepare");
      hydratedBytes.push(await fetchBytes(hydration, at, machineInputPath, signal));
      events.push("hydrate");
      const mount: MachineWorkspaceMount = {
        async canonicalCwd(command) {
          return command.cwd;
        },
        async changes(signal) {
          events.push("changes");
          if (signal !== fixture.recoverySignal) events.push("changes:wrong-signal");
          return options.changes?.() ?? (producedOutput ? [outputInode] : []);
        },
      };
      lastMount = mount;
      fixture.mount = mount;
      return mount;
    },
    async resume(input) {
      events.push("resume");
      const supplied = await options.resume?.(input);
      const mount = supplied?.mount ?? lastMount;
      if (!mount) throw new Error("Local machine fake has no workspace mount to resume");
      return {
        mount,
        ownership: supplied?.ownership ?? {
          operationId: input.operationId,
          machineId: input.machine.id,
          generation: input.machine.generation,
          before: input.before,
        },
      };
    },
    async apply(input: {
      readonly before: ForkCommit;
      readonly after: ForkCommit;
      readonly changedInodes: readonly CommitInode[];
      readonly hydration: FilePersistencePorts["hydration"];
      readonly signal: AbortSignal;
    }) {
      events.push("apply");
      if (input.signal !== fixture.recoverySignal) events.push("apply:wrong-signal");
      if (options.apply) return options.apply(input);
      appliedBytes.push(
        await fetchBytes(input.hydration, input.after, machineOutputPath, input.signal),
      );
    },
  };

  const localMachine: Machine = {
    async create(input, signal) {
      events.push("machine.create");
      createCalls.push(input);
      const created = options.createMachine
        ? await options.createMachine(input, signal, handle)
        : handle;
      machineCreated = true;
      return created;
    },
    async reconcile(input, signal) {
      events.push("machine.reconcile");
      if (options.reconcileMachine) return options.reconcileMachine(input, signal);
      if (machineDeleted) {
        return {
          status: "absent",
          absence: {
            operationId: input.operationId,
            reservationId: "local-reservation",
            name: handle.id,
            generation: handle.generation,
            machineId: handle.id,
            createStarted: true,
            reservationReleased: true,
            providerAbsent: true,
          },
          releaseReservation: async () => undefined,
        };
      }
      if (!machineCreated) {
        return {
          status: "absent",
          absence: {
            operationId: input.operationId,
            reservationId: null,
            name: null,
            generation: null,
            machineId: null,
            createStarted: false,
            reservationReleased: false,
            providerAbsent: true,
          },
          releaseReservation: async () => undefined,
        };
      }
      return {
        status: "owned",
        handle,
        ownership: {
          operationId: input.operationId,
          machineId: handle.id,
          generation: handle.generation,
        },
      };
    },
  };
  const bases = {
    async acquire() {
      events.push("base.acquire");
      return options.baseLease ? Option.some(options.baseLease) : Option.none();
    },
    async release(lease: BaseLease) {
      events.push("base.release");
      await options.releaseBase?.(lease);
    },
  };
  const localRuntime: MachineCommandRuntime = {
    async attach(input: Parameters<MachineCommandRuntime["attach"]>[0]) {
      events.push("attach");
      policy.push(input.policy);
      return {
        owner: {
          operationId: input.operationId,
          machineId: input.machine.id,
          generation: input.machine.generation,
        },
        async quiesce(_signal: AbortSignal) {
          events.push("runtime.quiesce");
          await options.runtimeDispose?.();
          return {
            operationId: input.operationId,
            machineId: input.machine.id,
            generation: input.machine.generation,
            closed: true as const,
          };
        },
        async spawn(command: KernelCommand, signal: AbortSignal) {
          events.push("spawn");
          spawnCalls.push(command);
          await input.policy.authorize(command, input.machine.generation, signal);
          if (options.spawn) return options.spawn(command, signal, fixture);
          producedOutput = true;
          return child;
        },
        async dispose() {
          events.push("runtime.dispose");
        },
      };
    },
    async rebind(input) {
      events.push("runtime.rebind");
      const supplied = await options.rebind?.(input);
      if (supplied) return supplied;
      return {
        owner: {
          operationId: input.operationId,
          machineId: input.machine.id,
          generation: input.machine.generation,
        },
        async quiesce(_signal: AbortSignal) {
          events.push("runtime.quiesce");
          await options.runtimeDispose?.();
          return {
            operationId: input.operationId,
            machineId: input.machine.id,
            generation: input.machine.generation,
            closed: true as const,
          };
        },
        async dispose() {
          events.push("runtime.dispose");
        },
      };
    },
  };
  const machine = options.machine ?? localMachine;
  const workspace = options.workspace ?? localWorkspace;
  const runtime = options.runtime ?? localRuntime;
  const commands = new MachineCommands({
    drive: "drive:test" as DriveRef,
    recipeHash: "recipe:test" as RecipeHash,
    bases,
    machines: machine,
    workspace,
    runtime,
    ports,
    journal: options.journal ?? memoryJournal,
    nextOperationId: () => "machine-op-1",
    coldExpiresAt: () => 2_000_000_000_000,
    recoverySignal: fixture.recoverySignal,
  });
  fixture.commands = commands;
  fixture.workspace = workspace;
  fixture.runtime = runtime;
  return fixture;
}
