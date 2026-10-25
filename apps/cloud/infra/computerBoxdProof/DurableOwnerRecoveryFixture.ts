import * as Effect from "effect/Effect";
import type { BaseLease, DriveRef, RecipeHash } from "../../src/computer/Computer.ts";
import { MachineCommands } from "../../src/computer/MachineCommands.ts";
import { RunnerMachineFileLookupForwarder } from "../../src/computer/MachineFileLookupForwarder.ts";
import { createRecoveryMachine } from "./RecoveryMachine.ts";
import {
  makeBoxdMachines,
  type BoxdMachineClient,
  type BoxdMachineRecord,
} from "../../src/computer/BoxdMachines.ts";
import { SqliteBoxdReservations } from "../../src/computer/SqliteBoxdReservations.ts";
import type { MachineHandle } from "../../src/computer/Machine.ts";
import { SqliteMachineCommandJournal } from "../../src/computer/SqliteMachineCommandJournal.ts";
import type {
  MachineCommandRuntime,
  MachineWorkspace,
  MachineWorkspaceMount,
} from "../../src/computer/MachineWorkspace.ts";
import type {
  CommitInode,
  FilePersistencePorts,
  ForkCommit,
} from "../../src/kernel/FilePersistencePorts.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandExit,
} from "../../src/kernel/KernelCommandForwarder.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createDurableProofBases } from "./DurableBases.ts";
import type { ProofBaseSource } from "./Bases.ts";
import { createDurableProofRevisionPorts } from "./DurableRevisionPorts.ts";

export const ownerDrive = "drive:durable-owner" as DriveRef;
export const ownerRecipe = "recipe:durable-owner" as RecipeHash;
export const ownerOperationId = "durable-owner-op";
export const ownerBefore: ForkCommit = {
  repository: "owner-recovery",
  fork: "thread",
  commit: "before",
};
export const ownerBeforeBytes = new Uint8Array([1, 3, 5]);
export const ownerOutputBytes = new Uint8Array([8, 0, 13, 255]);
export const ownerCommand: KernelCommand = {
  executable: "/usr/bin/tool",
  argv: ["tool", "--write"],
  cwd: "/workspace",
  env: {},
};

// These maps stand in for external Boxd and VM state. They never contain owner objects.
export interface DurableOwnerExternalState {
  readonly machines: Map<string, BoxdMachineRecord>;
  readonly mountIds: number[];
  baseSourcePresent: boolean;
  nextLeaseId: number;
  forkCalls: number;
  deleteCalls: number;
  commandStarts: number;
  runtimeDisposals: number;
  baseReleaseCalls: number;
  commandClosed: boolean;
  nativeBytes?: Uint8Array;
  nativeInode: bigint;
  applied?: {
    readonly before: string;
    readonly after: string;
    readonly path: string;
    readonly inode: bigint;
    readonly bytes: Uint8Array;
  };
  applyCalls: number;
  applyAttempts: number;
}

export function createExternalState(): DurableOwnerExternalState {
  return {
    machines: new Map(),
    mountIds: [],
    baseSourcePresent: true,
    nextLeaseId: 1,
    forkCalls: 0,
    deleteCalls: 0,
    commandStarts: 0,
    runtimeDisposals: 0,
    baseReleaseCalls: 0,
    commandClosed: false,
    nativeInode: 73n,
    applyCalls: 0,
    applyAttempts: 0,
  };
}

export function seedBefore(storage: FacetStorage) {
  createDurableProofRevisionPorts(storage).seedFile(ownerBefore, "/out.bin", ownerBeforeBytes);
}

export function inspectBaseLeases(storage: FacetStorage, external: DurableOwnerExternalState) {
  return createDurableProofBases(storage, proofBaseSource(external)).inspect();
}

function boxdClient(external: DurableOwnerExternalState): BoxdMachineClient {
  const record = (name: string, id: string): BoxdMachineRecord => ({
    id,
    name,
    status: "running",
    shared: false,
    networking: { isolated: true, networks: [] },
    idle: { destroyAfter: 0 },
    deleteAt: null,
  });
  return {
    machines: {
      async create(input) {
        const id = `machine-${external.forkCalls + 1}`;
        external.machines.set(input.name, record(input.name, id));
        return { id };
      },
      async fork(_source, input) {
        external.forkCalls++;
        const id = `machine-${external.forkCalls}`;
        external.machines.set(input.name, record(input.name, id));
        return { id };
      },
      async get(name) {
        return external.machines.get(name) ?? null;
      },
      async delete(id) {
        external.deleteCalls++;
        for (const [name, machine] of external.machines) {
          if (machine.id === id) external.machines.delete(name);
        }
      },
      async setDeleteAfter() {},
      proxies: {
        async setPort() {},
        async list() {
          return [{ isDefault: true, port: 65535, portMode: "locked" }];
        },
      },
    },
  };
}

function proofBaseSource(external: DurableOwnerExternalState): ProofBaseSource {
  return {
    drive: ownerDrive,
    recipeHash: ownerRecipe,
    sourceRef: "provider-base",
    async verifyHeldSource() {
      if (!external.baseSourcePresent) throw new Error("Provider Base source is no longer held");
    },
    now: () => 1_800_000_000_000,
    nextLeaseId: () => `durable-lease-${external.nextLeaseId++}`,
  };
}

function changedInode(bytes: Uint8Array, inode: bigint): CommitInode {
  const snapshot = bytes.slice();
  return {
    inode,
    paths: ["/out.bin"],
    removedPaths: [],
    stat: {
      type: "file",
      size: BigInt(snapshot.byteLength),
      nlink: 1n,
      atimeNs: 2n,
      mtimeNs: 3n,
      ctimeNs: 4n,
    },
    symlinkTarget: null,
    async *readChunks() {
      yield snapshot.slice(0, 2);
      yield snapshot.slice(2);
    },
  };
}

function child(): KernelCommandChild {
  return {
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: new Promise<KernelCommandExit>(() => undefined),
    async signal() {
      return { status: "ok", value: undefined };
    },
    async dispose() {},
  };
}

function machineRuntime(external: DurableOwnerExternalState): MachineCommandRuntime {
  const settlement = (input: {
    readonly operationId: string;
    readonly machine: MachineHandle;
  }) => ({
    owner: {
      operationId: input.operationId,
      machineId: input.machine.id,
      generation: input.machine.generation,
    },
    async quiesce(signal: AbortSignal) {
      signal.throwIfAborted();
      if (!external.commandClosed) throw new Error("Runner closure ownership is unknown");
      return {
        operationId: input.operationId,
        machineId: input.machine.id,
        generation: input.machine.generation,
        closed: true as const,
      };
    },
    async dispose() {
      external.runtimeDisposals++;
    },
  });
  return {
    async attach(input) {
      return {
        ...settlement(input),
        machineFiles: new RunnerMachineFileLookupForwarder(),
        async spawn() {
          external.commandStarts++;
          external.commandClosed = false;
          external.nativeBytes = ownerOutputBytes.slice();
          return child();
        },
      };
    },
    async rebind(input) {
      return settlement(input);
    },
  };
}

function machineWorkspace(
  external: DurableOwnerExternalState,
  options: { readonly loseApplyAck?: boolean },
): MachineWorkspace {
  let loseApplyAck = options.loseApplyAck ?? false;
  const freshMount = (): MachineWorkspaceMount => {
    external.mountIds.push(external.mountIds.length + 1);
    return {
      async canonicalCwd(command) {
        return command.cwd;
      },
      async changes(signal) {
        signal.throwIfAborted();
        if (!external.nativeBytes) throw new Error("VM workspace has no persisted output");
        return [changedInode(external.nativeBytes, external.nativeInode)];
      },
    };
  };
  const fetchBytes = async (
    hydration: FilePersistencePorts["hydration"],
    at: ForkCommit,
    signal: AbortSignal,
  ) => {
    const result = await hydration.fetch({ at, paths: ["/out.bin"], signal });
    if (result.status !== "ok") throw new Error(result.error.message);
    const parts: Uint8Array[] = [];
    for await (const part of result.value[0]!.chunks) parts.push(part);
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  };
  return {
    async checkpoint() {
      return ownerBefore;
    },
    async prepare(_machine, at, hydration, signal) {
      const hydrated = await fetchBytes(hydration, at, signal);
      if (
        hydrated.byteLength !== ownerBeforeBytes.byteLength ||
        !hydrated.every((byte, index) => byte === ownerBeforeBytes[index])
      ) {
        throw new Error("VM did not hydrate the persisted before revision");
      }
      external.nativeBytes = hydrated;
      return freshMount();
    },
    async resume(input) {
      if (
        input.before.repository !== ownerBefore.repository ||
        input.before.fork !== ownerBefore.fork ||
        input.before.commit !== ownerBefore.commit
      ) {
        throw new Error("Replacement VM mount was given a different before revision");
      }
      return {
        mount: freshMount(),
        ownership: {
          operationId: input.operationId,
          machineId: input.machine.id,
          generation: input.machine.generation,
          before: input.before,
        },
      };
    },
    async apply(input) {
      const bytes = await fetchBytes(input.hydration, input.after, input.signal);
      const inode = input.changedInodes[0]?.inode;
      if (inode === undefined || inode !== external.nativeInode)
        throw new Error("Apply lost the VM's persisted inode identity");
      external.applyAttempts++;
      const alreadyApplied =
        external.applied?.before === input.before.commit &&
        external.applied.after === input.after.commit &&
        external.applied.path === "/out.bin" &&
        external.applied.inode === inode &&
        external.applied.bytes.byteLength === bytes.byteLength &&
        external.applied.bytes.every((byte, index) => byte === bytes[index]);
      external.nativeBytes = bytes.slice();
      if (!alreadyApplied) {
        external.applied = {
          before: input.before.commit,
          after: input.after.commit,
          path: "/out.bin",
          inode,
          bytes,
        };
        external.applyCalls++;
      }
      if (loseApplyAck) {
        loseApplyAck = false;
        throw new Error("Workspace apply acknowledgement was lost");
      }
    },
  };
}

export function createFreshOwner(
  storage: FacetStorage,
  external: DurableOwnerExternalState,
  options: {
    readonly loseCommitAck?: boolean;
    readonly loseApplyAck?: boolean;
    readonly recoveryOnly?: boolean;
  } = {},
) {
  const journal = new SqliteMachineCommandJournal(storage);
  const durableBases = createDurableProofBases(storage, proofBaseSource(external));
  const bases = {
    acquire: () => Effect.runPromise(durableBases.bases.acquire(ownerDrive, ownerRecipe)),
    async release(base: BaseLease) {
      await Effect.runPromise(durableBases.bases.release(base));
      external.baseReleaseCalls++;
    },
  };
  const durableRevisions = createDurableProofRevisionPorts(storage);
  let loseCommitAck = options.loseCommitAck ?? false;
  const ports: FilePersistencePorts = {
    hydration: durableRevisions.hydration,
    commits: {
      async commit(input) {
        const result = await durableRevisions.commits.commit(input);
        if (loseCommitAck && result.status === "ok") {
          loseCommitAck = false;
          return {
            status: "error",
            error: { code: "IO_ERROR", message: "Revision commit acknowledgement was lost" },
          };
        }
        return result;
      },
    },
  };
  const machine = makeBoxdMachines(
    boxdClient(external),
    new SqliteBoxdReservations(storage, () => "durable-owner-reservation"),
    { org: "proof", image: "proof-runner", vcpu: 1, memory: "4G" },
    () => 1_800_000_000_000,
  );
  const workspace = machineWorkspace(external, options);
  const runtime = machineRuntime(external);
  const machineOptions = {
    drive: ownerDrive,
    recipeHash: ownerRecipe,
    bases,
    machines: machine,
    workspace,
    runtime,
    ports,
    journal,
    nextOperationId: () => ownerOperationId,
    coldExpiresAt: () => 1_900_000_000_000,
    recoverySignal: new AbortController().signal,
  };
  if (options.recoveryOnly) {
    return createRecoveryMachine({
      drive: ownerDrive,
      recipeHash: ownerRecipe,
      bases,
      machines: machine,
      workspace,
      runtime,
      hydration: ports.hydration,
      journal,
      recoverySignal: machineOptions.recoverySignal,
    });
  }
  return new MachineCommands(machineOptions);
}

export async function leaveExecutionPending(
  storage: FacetStorage,
  external: DurableOwnerExternalState,
) {
  const firstOwner = createFreshOwner(storage, external);
  await firstOwner.spawn(ownerCommand, new AbortController().signal);
  return new SqliteMachineCommandJournal(storage).read(ownerOperationId);
}
